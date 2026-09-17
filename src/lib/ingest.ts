// Corpus ingestion lanes: classify by file class, gate text before it
// grounds anything, record lane + verdict + status per document. Uploads
// stream (A15): the route classifies by type, counts and caps the body,
// and only the native text lane decodes in-request beyond that; model lanes
// (OCR/rescue) record an honest held status the engine (T5) drains. Hostile
// input fails loud.

import {
  canonicaliseText,
  quarantineText,
  type QuarantineHit,
} from "./intake";

/** 25 MB per document: above this, fail closed, never truncate silently. */
export const MAX_DOC_BYTES = 25 * 1024 * 1024;

export type Lane =
  | "native"
  | "held-pdf"
  | "held-docx"
  | "held-xlsx"
  | "held-pptx"
  | "held-email"
  | "held-archive"
  | "held-ocr"
  | "rejected";

export interface LaneDecision {
  lane: Lane;
  reason?: string;
  /** Native delimited-table formatting for CSV/TSV text (C5). */
  table?: "csv" | "tsv";
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
  if ([".txt", ".md", ".markdown"].includes(extension)) {
    return { lane: "native" };
  }
  if (extension === ".csv") {
    return { lane: "native", table: "csv" };
  }
  if (extension === ".tsv") {
    return { lane: "native", table: "tsv" };
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
    extension === ".eml" ||
    extension === ".mbox" ||
    extension === ".mbx" ||
    mime === "message/rfc822" ||
    mime === "application/mbox"
  ) {
    return {
      lane: "held-email",
      reason: "email parses natively on drain; the model pass is the fallback",
    };
  }
  if (
    extension === ".zip" ||
    mime === "application/zip" ||
    mime === "application/x-zip-compressed"
  ) {
    return {
      lane: "held-archive",
      reason: "members parse natively on drain; the model pass is the fallback",
    };
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
  /** The pseudonyms the gate wrote into the text, paired with their names,
   *  so the caller seals and indexes the marker the reader actually sees. */
  hits: QuarantineHit[];
}

/**
 * Name-leak gate for corpus text: quarantine names BEFORE mirror write.
 * Returns scrubbed text plus the sealed-later names. Text is canonicalised
 * first (format characters removed) so what is scanned is what is stored.
 */
export function gateCorpusText(raw: string): GatedText {
  const canonical = canonicaliseText(raw);
  const { scrubbed, hits } = quarantineText(canonical);
  if (hits.length === 0) {
    return { text: canonical, verdict: "clean", names: [], hits: [] };
  }
  return {
    text: scrubbed,
    verdict: "gated",
    names: hits.map((h) => h.name),
    hits,
  };
}

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
