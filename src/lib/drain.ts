// Corpus drain: held-* lanes become gated mirror text. Lane routing,
// gate-before-mirror, honest failure states. Document lanes try the native
// parser first (digital text) and fall back to the model pass only when
// native parsing cannot read the file; this module owns the state machine
// and the safety rules.

import { gateCorpusText } from "./ingest";
import type { QuarantineHit } from "./intake";
import { extractNativeText } from "./native";
import type { ModelClient } from "./serve";

export interface HeldDoc {
  id: string;
  lane: string;
  status: string;
  bytes_b64: string;
  /** Object-store key when the raw bytes are still held (R2). */
  raw_key?: string | null;
}

export interface DrainStep {
  id: string;
  lane: string;
  handler: "document" | "vision" | "slides" | "sheets";
}

const CAPABILITY: Record<DrainStep["handler"], string> = {
  document: "document text extraction",
  vision: "image OCR (vision)",
  slides: "slide text extraction",
  sheets: "spreadsheet text extraction",
};

const LANE_HANDLERS: Record<string, DrainStep["handler"] | undefined> = {
  "held-pdf": "document",
  "held-docx": "document",
  "held-xlsx": "sheets",
  "held-pptx": "slides",
  "held-ocr": "vision",
};

/** Determine the drain order: held docs only, each with its handler. */
export function drainPlan(docs: HeldDoc[]): DrainStep[] {
  return docs
    .filter((d) => d.status === "held")
    .map((d) => ({ id: d.id, lane: d.lane, handler: LANE_HANDLERS[d.lane] }))
    .filter((s): s is DrainStep => s.handler !== undefined);
}

export type LaneResult =
  | { ok: true; text: string; tier: string; status?: "parsed" | "OCRed" | "rescued" }
  | { ok: false; reason: string; tier: string };

export interface DrainOutcome {
  id: string;
  status: "parsed" | "OCRed" | "rescued" | "held";
  verdict: "clean" | "gated" | "pending";
  reason: string | null;
  text: string;
  /** Quarantined names discovered during the gate (sealed by the caller). */
  names: string[];
  /** Pseudonym markers in the gated text, paired with their names. */
  hits: QuarantineHit[];
}

/**
 * Apply a lane result. Success runs the name-leak gate BEFORE mirror
 * write (only gated text is ever returned for storage); failure keeps the
 * file held with the handler's actionable reason. Never a partial write.
 */
export function applyDrain(doc: HeldDoc, result: LaneResult): DrainOutcome {
  if (!result.ok) {
    return {
      id: doc.id,
      status: "held",
      verdict: "pending",
      reason: result.reason,
      text: "",
      names: [],
      hits: [],
    };
  }
  if (result.text.trim().length === 0) {
    return {
      id: doc.id,
      status: "held",
      verdict: "pending",
      reason: "extraction produced no text",
      text: "",
      names: [],
      hits: [],
    };
  }
  const gated = gateCorpusText(result.text);
  return {
    id: doc.id,
    status: result.status ?? "parsed",
    verdict: gated.verdict,
    reason: null,
    text: gated.text,
    names: gated.names,
    hits: gated.hits,
  };
}

export interface DrainHandler {
  handler: DrainStep["handler"];
  tier: string;
  extract(doc: HeldDoc): Promise<LaneResult>;
}

/** Subset of the Workers AI binding the lanes use. */
export interface AiBinding {
  toMarkdown?(doc: { name: string; blob: Blob }): Promise<unknown>;
  run?(model: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface DrainProviders {
  /** Workers AI binding: keyless document conversion + vision OCR. */
  ai?: AiBinding;
  /** Registry chain restricted to vision-capable entries, when configured. */
  visionClient?: ModelClient | null;
}

const OCR_MODEL = "@cf/moondream/moondream3.1-9B-A2B";

function decodeB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Run the drain: for each planned doc, extract through its lane handler,
 * gate, and report. Missing handlers degrade loudly (file stays held).
 * The caller persists outcomes and telemetry; this returns the decisions.
 */
export async function runDrain(
  docs: HeldDoc[],
  handlers: DrainHandler[],
): Promise<{ results: Array<{ doc: HeldDoc; outcome: DrainOutcome; tier: string }> }> {
  const byHandler = new Map(handlers.map((h) => [h.handler, h]));
  const results: Array<{ doc: HeldDoc; outcome: DrainOutcome; tier: string }> = [];
  for (const step of drainPlan(docs)) {
    const doc = docs.find((d) => d.id === step.id) as HeldDoc;
    const handler = byHandler.get(step.handler);
    if (!handler) {
      const capability = CAPABILITY[step.handler] ?? step.handler;
      results.push({
        doc,
        tier: "none",
        outcome: applyDrain(doc, {
          ok: false,
          reason:
            `no capable provider configured for ${step.lane} — ` +
            `add a model with ${capability} to drain this file`,
          tier: "none",
        }),
      });
      continue;
    }
    let laneResult: LaneResult;
    try {
      laneResult = await handler.extract(doc);
    } catch (err) {
      laneResult = {
        ok: false,
        reason: `extraction failed: ${(err as Error)?.message ?? err}`,
        tier: handler.tier,
      };
    }
    results.push({
      doc,
      tier: laneResult.tier,
      outcome: applyDrain(doc, laneResult),
    });
  }
  return { results };
}

/**
 * Lane handlers over native parsers first, then the Workers AI binding
 * (keyless document conversion and vision OCR) with the operator's
 * vision-tagged registry entries preferred for OCR. Document bytes travel
 * as Blobs or image data, never as base64 inside a text prompt. The caller
 * gates and quarantines the output.
 */
export function buildDrainHandlers(providers: DrainProviders): DrainHandler[] {
  const documentLane = (handler: DrainStep["handler"]): DrainHandler => ({
    handler,
    tier: providers.ai?.toMarkdown ? "workers-ai-toMarkdown" : "none",
    extract: async (doc: HeldDoc): Promise<LaneResult> => {
      // Native parse first: digital text never needs the model pass.
      const native = await extractNativeText(doc.lane, decodeB64(doc.bytes_b64));
      if (native) {
        return {
          ok: true,
          text: native.text,
          tier: native.tier,
          status: "parsed",
        };
      }
      // The model pass is the fallback, used only when the native parser
      // cannot read the file (scans, encrypted files, unsupported subsets).
      if (!providers.ai?.toMarkdown) {
        return {
          ok: false,
          reason:
            `no capable provider configured for ${doc.lane} — ` +
            "add a model with document text extraction to drain this file",
          tier: "none",
        };
      }
      try {
        const raw = await providers.ai.toMarkdown({
          name: `document-${doc.id}`,
          blob: new Blob([decodeB64(doc.bytes_b64)]),
        });
        const res = (Array.isArray(raw) ? raw[0] : raw) as {
          format?: string;
          data?: string;
          error?: string;
        };
        if (res?.format === "error" || !res?.data?.trim()) {
          return {
            ok: false,
            reason: `document extraction produced no text${
              res?.error ? `: ${res.error}` : ""
            }`,
            tier: "workers-ai-toMarkdown",
          };
        }
        return {
          ok: true,
          text: res.data,
          tier: "workers-ai-toMarkdown",
          status: "parsed",
        };
      } catch (err) {
        return {
          ok: false,
          reason: `document extraction failed: ${
            (err as Error)?.message ?? err
          }`,
          tier: "workers-ai-toMarkdown",
        };
      }
    },
  });

  const visionLane: DrainHandler = {
    handler: "vision",
    tier: providers.visionClient
      ? providers.visionClient.tier
      : providers.ai?.run
        ? "workers-ai-vision"
        : "none",
    extract: async (doc: HeldDoc): Promise<LaneResult> => {
      const instruction =
        "Transcribe all visible text in this image exactly, preserving " +
        "reading order and structure. Reply with text only.";
      // Prefer the operator's vision-tagged registry entry.
      if (providers.visionClient?.completeVision) {
        try {
          const text = await providers.visionClient.completeVision(
            instruction,
            doc.bytes_b64,
            "image/png",
          );
          if (text.trim()) {
            return {
              ok: true,
              text,
              tier: providers.visionClient.tier,
              status: "OCRed",
            };
          }
        } catch {
          // Fall through to the keyless tier.
        }
      }
      if (providers.ai?.run) {
        try {
          const out = (await providers.ai.run(OCR_MODEL, {
            task: "query",
            image: `data:image/png;base64,${doc.bytes_b64}`,
            question: instruction,
          })) as { answer?: string };
          const text = out?.answer ?? "";
          if (!text.trim()) {
            return {
              ok: false,
              reason: "vision OCR produced no text",
              tier: "workers-ai-vision",
            };
          }
          return {
            ok: true,
            text,
            tier: "workers-ai-vision",
            // After a registry vision attempt, the keyless pass is a rescue.
            status: providers.visionClient ? "rescued" : "OCRed",
          };
        } catch (err) {
          return {
            ok: false,
            reason: `vision OCR failed: ${(err as Error)?.message ?? err}`,
            tier: "workers-ai-vision",
          };
        }
      }
      return {
        ok: false,
        reason:
          "no capable provider configured for held-ocr — add a " +
          "vision-capable model entry or enable Workers AI",
        tier: "none",
      };
    },
  };

  return [
    documentLane("document"),
    documentLane("sheets"),
    documentLane("slides"),
    visionLane,
  ];
}
