// Minimal XML scanner for OOXML parts (DOCX/XLSX/PPTX). It is deliberately
// not a general XML parser: it walks tags and surfaces open/close/text
// events for the small vocabularies the document parsers care about, with
// entity decoding and quoted attributes handled correctly. Malformed
// markup ends the scan rather than throwing; callers see what was read.

export type XmlEvent =
  | {
      kind: "open";
      name: string;
      attrs: Record<string, string>;
      selfClosing: boolean;
    }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** Decode XML character and entity references. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (all, ref) => {
    if (ref[0] === "#") {
      const code =
        ref[1] === "x" || ref[1] === "X"
          ? parseInt(ref.slice(2), 16)
          : parseInt(ref.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return all;
      try {
        return String.fromCodePoint(code);
      } catch {
        return all;
      }
    }
    return NAMED_ENTITIES[ref] ?? all;
  });
}

function tagEnd(xml: string, from: number): number {
  let quote = "";
  for (let i = from; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttrs(body: string, from: number): Record<string, string> {
  const attrs: Record<string, string> = {};
  let i = from;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    let nameEnd = i;
    while (nameEnd < body.length && !/[\s=]/.test(body[nameEnd])) nameEnd++;
    if (nameEnd === i) break;
    const name = body.slice(i, nameEnd);
    i = nameEnd;
    while (i < body.length && /\s/.test(body[i])) i++;
    if (body[i] !== "=") {
      attrs[name] = "";
      continue;
    }
    i++;
    while (i < body.length && /\s/.test(body[i])) i++;
    let value = "";
    const quote = body[i];
    if (quote === '"' || quote === "'") {
      const end = body.indexOf(quote, i + 1);
      if (end < 0) break;
      value = body.slice(i + 1, end);
      i = end + 1;
    } else {
      let end = i;
      while (end < body.length && !/\s/.test(body[end])) end++;
      value = body.slice(i, end);
      i = end;
    }
    attrs[name] = decodeXmlEntities(value);
  }
  return attrs;
}

/** Walk an XML string, emitting open/close/text events in document order. */
export function scanXml(xml: string, emit: (event: XmlEvent) => void): void {
  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      emit({ kind: "text", text: decodeXmlEntities(xml.slice(i)) });
      return;
    }
    if (lt > i) emit({ kind: "text", text: decodeXmlEntities(xml.slice(i, lt)) });
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end < 0 ? n : end;
      emit({ kind: "text", text: xml.slice(lt + 9, stop) });
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE or declaration: skip, honouring an internal subset.
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        if (xml[j] === "[") depth++;
        else if (xml[j] === "]") depth--;
        else if (xml[j] === ">" && depth <= 0) break;
      }
      i = j >= n ? n : j + 1;
      continue;
    }
    const end = tagEnd(xml, lt + 1);
    if (end < 0) {
      emit({ kind: "text", text: decodeXmlEntities(xml.slice(lt)) });
      return;
    }
    const raw = xml.slice(lt + 1, end);
    i = end + 1;
    if (raw.startsWith("/")) {
      emit({ kind: "close", name: raw.slice(1).trim() });
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    let nameEnd = 0;
    while (nameEnd < body.length && !/[\s/]/.test(body[nameEnd])) nameEnd++;
    const name = body.slice(0, nameEnd);
    emit({
      kind: "open",
      name,
      attrs: parseAttrs(body, nameEnd),
      selfClosing,
    });
    if (selfClosing) emit({ kind: "close", name });
  }
}
