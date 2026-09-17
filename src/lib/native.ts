// Native lane dispatch: digital documents parse in JS before any model
// pass, per ADR-0002/ADR-0011. Returns null when the format or the bytes
// fall outside the native subset, so the lane falls back to the model.

import { extractArchiveText } from "./archive";
import { extractEmailText } from "./email";
import { extractDocxText, extractPptxText, extractXlsxText } from "./ooxml";
import { extractPdfText } from "./pdf";

export interface NativeText {
  text: string;
  tier: string;
}

export const NATIVE_TIERS: Record<string, string> = {
  "held-pdf": "native-pdf",
  "held-docx": "native-docx",
  "held-xlsx": "native-xlsx",
  "held-pptx": "native-pptx",
  "held-email": "native-email",
  "held-archive": "native-archive",
};

/**
 * Try the native parser for one lane. Never throws: an unsupported lane,
 * malformed bytes, an encrypted document or an empty text layer all
 * return null, which the drain reads as "use the model pass".
 */
export async function extractNativeText(
  lane: string,
  bytes: Uint8Array,
): Promise<NativeText | null> {
  try {
    let text = "";
    switch (lane) {
      case "held-pdf":
        text = await extractPdfText(bytes);
        break;
      case "held-docx":
        text = await extractDocxText(bytes);
        break;
      case "held-xlsx":
        text = await extractXlsxText(bytes);
        break;
      case "held-pptx":
        text = await extractPptxText(bytes);
        break;
      case "held-email":
        text = extractEmailText(bytes);
        break;
      case "held-archive":
        text = await extractArchiveText(bytes, extractNativeText);
        break;
      default:
        return null;
    }
    const trimmed = text.trim();
    if (!trimmed) return null;
    return { text, tier: NATIVE_TIERS[lane] ?? "native" };
  } catch {
    return null;
  }
}
