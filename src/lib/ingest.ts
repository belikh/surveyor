// Corpus ingestion lanes: classify by file class, gate text before it
// grounds anything, record lane + verdict + status per document. Nothing
// is parsed in-request beyond text; model lanes (OCR/rescue) record an
// honest held status the engine (T5) drains. Hostile input fails loud.

import { z } from "zod";
import { quarantineText } from "./intake";

/** 25 MB per document: above this, fail closed, never truncate silently. */
export const MAX_DOC_BYTES = 25 * 1024 * 1024;

export type Lane =
  | "native"
  | "held-pdf"
  | "held-docx"
  | "held-xlsx"
  | "held-pptx"
  | "held-ocr"
  | "rejected";

export interface LaneDecision {
  lane: Lane;
  reason?: string;
}

const ext = (filename: string): string => {
  const i = filename.toLowerCase().lastIndexOf(".");
  return i === -1 ? "" : filename.toLowerCase().slice(i);
};

export function classifyLane(
  filename: string,
  contentType: string,
  sizeBytes: number,
): LaneDecision {  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return { lane: "rejected", reason: "empty document" };
  }
  if (sizeBytes > MAX_DOC_BYTES) {
    return {
      lane: "rejected",
      reason: `size ${sizeBytes} exceeds cap ${MAX_DOC_BYTES}`,
    };
  }
  const extension = ext(filename);
  const mime = contentType.toLowerCase();
  if ([".txt", ".md", ".markdown", ".csv", ".tsv"].includes(extension)) {
    return { lane: "native" };
  }
  if (extension === ".pdf" || mime === "application/pdf") {
    return { lane: "held-pdf", reason: "page render needs the model pass" };
  }
  if (extension === ".docx") {
    return { lane: "held-docx", reason: "document parse needs the model pass" };
  }
  if (extension === ".xlsx") {
    return { lane: "held-xlsx", reason: "sheet parse needs the model pass" };
  }
  if (extension === ".pptx") {
    return { lane: "held-pptx", reason: "slide walk needs the model pass" };
  }
  if (
    extension === ".png" ||
    extension === ".jpg" ||
    extension === ".jpeg" ||
    mime.startsWith("image/")
  ) {
    return { lane: "held-ocr", reason: "vision OCR needs the model pass" };
  }
  return { lane: "rejected", reason: `unsupported type ${extension || mime}` };
}

export type GateVerdict = "clean" | "gated" | "pending";

export interface GatedText {
  text: string;
  verdict: GateVerdict;
  names: string[];
}

/**
 * Name-leak gate for corpus text: quarantine names BEFORE mirror write.
 * Returns scrubbed text plus the sealed-later names.
 */
export function gateCorpusText(raw: string): GatedText {
  const { scrubbed, hits } = quarantineText(raw);
  if (hits.length === 0) {
    return { text: raw, verdict: "clean", names: [] };
  }
  return {
    text: scrubbed,
    verdict: "gated",
    names: hits.map((h) => h.name),
  };
}

export const UploadBodySchema = z.object({
  filename: z.string().min(1).max(256),
  content_type: z.string().min(1).max(128),
  content_b64: z.string().min(1).max(MAX_DOC_BYTES * 2),
});

export type DocStatus =
  | "parsed"
  | "OCRed"
  | "rescued"
  | "held"
  | "rejected";

/** Status assigned at ingest time. Only the text lane parses; every other
 *  non-rejected lane waits on the model pass (T5 drains held docs). */
export function statusFor(lane: Lane): DocStatus {
  if (lane === "rejected") return "rejected";
  if (lane === "native") return "parsed";
  return "held";
}
