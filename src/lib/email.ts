// Native email export extraction (C3): EML and mbox files parse to text
// without a model pass. Headers are reduced to what an investigation needs —
// date, participants and thread subject — while bodies are MIME-decoded
// (base64, quoted-printable, charsets, multipart alternatives). Messages are
// threaded by Message-ID, References and In-Reply-To, so the mirror carries
// the conversation structure. Limits are explicit markers, never silent
// loss. A file with no recognisable email headers yields nothing, so the
// lane falls back to the model pass.

/** Messages read from one export before the truncation marker. */
export const MAX_EMAIL_MESSAGES = 2000;
/** Total characters one export may contribute to the mirror. */
export const MAX_EMAIL_CHARS = 4 * 1024 * 1024;

interface EmailMessage {
  seq: number;
  id: string | null;
  references: string[];
  date: string;
  from: string;
  to: string;
  subject: string;
  body: string;
}

const HEADER_NAMES = [
  "from",
  "to",
  "cc",
  "date",
  "subject",
  "message-id",
  "in-reply-to",
  "references",
  "content-type",
  "mime-version",
];

/** Byte-preserving latin1 decode: char codes are the original bytes, so a
 *  header's declared charset can still be honoured for its body. */
function latin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

function toBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

function decodeBytes(bytes: Uint8Array, charset?: string): string {
  const label = (charset ?? "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function base64Bytes(payload: string): Uint8Array | null {
  try {
    const bin = atob(payload.replace(/\s+/g, ""));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** Quoted-printable over bytes, so the declared charset decodes after. */
function quotedPrintableBytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "=") {
      out.push(s.charCodeAt(i) & 0xff);
      continue;
    }
    if (s[i + 1] === "\r" && s[i + 2] === "\n") {
      i += 2;
      continue;
    }
    if (s[i + 1] === "\n") {
      i += 1;
      continue;
    }
    const hex = s.slice(i + 1, i + 3);
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
      continue;
    }
    out.push(0x3d);
  }
  return new Uint8Array(out);
}

/** RFC 2047 encoded words in header values: =?charset?B|Q?payload?=. */
function decodeMimeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (whole, charset: string, encoding: string, payload: string) => {
      const bytes =
        encoding.toLowerCase() === "b"
          ? base64Bytes(payload)
          : quotedPrintableBytes(payload.replace(/_/g, " "));
      return bytes ? decodeBytes(bytes, charset) : whole;
    },
  );
}

function getParam(value: string, name: string): string | undefined {
  const m = new RegExp(`;\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]*))`, "i").exec(
    value,
  );
  const param = (m?.[1] ?? m?.[2] ?? "").trim();
  return param || undefined;
}

function parseHeaders(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  let last: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && last) {
      const values = headers.get(last) as string[];
      values[values.length - 1] += ` ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      last = null;
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const values = headers.get(name) ?? [];
    values.push(line.slice(colon + 1).trim());
    headers.set(name, values);
    last = name;
  }
  return headers;
}

function splitHeaderBody(raw: string): {
  headers: Map<string, string[]>;
  body: string;
} {
  const blank = /\r?\n\r?\n/.exec(raw);
  if (!blank) return { headers: parseHeaders(raw), body: "" };
  return {
    headers: parseHeaders(raw.slice(0, blank.index)),
    body: raw.slice(blank.index + blank[0].length),
  };
}

function decodePart(body: string, contentType: string, encoding: string): string {
  const transfer = encoding.trim().toLowerCase();
  if (transfer === "base64") {
    const bytes = base64Bytes(body);
    return bytes ? decodeBytes(bytes, getParam(contentType, "charset")) : "";
  }
  if (transfer === "quoted-printable") {
    return decodeBytes(quotedPrintableBytes(body), getParam(contentType, "charset"));
  }
  return decodeBytes(toBytes(body), getParam(contentType, "charset"));
}

function splitParts(body: string, boundary: string): string[] {
  const marker = `--${boundary}`;
  const parts: string[] = [];
  let current: string[] | null = null;
  for (const line of body.split(/\r?\n/)) {
    if (line === marker || line === `${marker}--`) {
      if (current) parts.push(current.join("\n"));
      current = line === marker ? [] : null;
      continue;
    }
    if (current) current.push(line);
  }
  if (current) parts.push(current.join("\n"));
  return parts;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Text of one MIME entity; multipart prefers plain parts over HTML. */
function partText(body: string, contentType: string, encoding: string): string {
  const type = contentType.split(";")[0].trim().toLowerCase();
  if (type.startsWith("multipart/")) {
    const boundary = getParam(contentType, "boundary");
    if (!boundary) return "";
    const plain: string[] = [];
    const any: string[] = [];
    for (const part of splitParts(body, boundary)) {
      const { headers, body: partBody } = splitHeaderBody(part);
      const disposition = headers.get("content-disposition")?.[0] ?? "";
      if (/attachment/i.test(disposition)) continue;
      const partType = headers.get("content-type")?.[0] ?? "text/plain";
      const partEncoding =
        headers.get("content-transfer-encoding")?.[0] ?? "";
      const text = partText(partBody, partType, partEncoding);
      if (!text.trim()) continue;
      any.push(text);
      if (partType.toLowerCase().startsWith("text/plain")) plain.push(text);
    }
    return (plain.length > 0 ? plain : any).join("\n");
  }
  if (type !== "text/plain" && type !== "text/html") return "";
  const decoded = decodePart(body, contentType, encoding);
  return type === "text/html" ? stripHtml(decoded) : decoded;
}

function messageId(value: string | undefined): string | null {
  if (!value) return null;
  const m = /<[^<>]+>/.exec(value);
  return (m?.[0] ?? value.trim()) || null;
}

function parseMessage(raw: string, seq: number): EmailMessage | null {
  const { headers, body } = splitHeaderBody(raw);
  if (!HEADER_NAMES.some((name) => headers.has(name))) return null;
  const contentType = headers.get("content-type")?.[0] ?? "text/plain";
  const encoding = headers.get("content-transfer-encoding")?.[0] ?? "";
  const references = [
    ...(headers.get("references") ?? []),
    headers.get("in-reply-to")?.[0] ?? "",
  ]
    .join(" ")
    .match(/<[^<>]+>/g);
  return {
    seq,
    id: messageId(headers.get("message-id")?.[0]),
    references: references ?? [],
    date: decodeMimeWords(headers.get("date")?.[0] ?? "").trim(),
    from: decodeMimeWords(headers.get("from")?.[0] ?? "").trim(),
    to: decodeMimeWords(headers.get("to")?.[0] ?? "").trim(),
    subject: decodeMimeWords(headers.get("subject")?.[0] ?? "")
      .replace(/\s+/g, " ")
      .trim(),
    body: partText(body, contentType, encoding).replace(/\r\n/g, "\n").trim(),
  };
}

/**
 * Split an mbox export on its `From ` separator lines (mboxo). Body lines
 * that were escaped as `>From ` are unescaped so they survive the split.
 */
function splitMbox(raw: string): string[] {
  const messages: string[] = [];
  let current: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("From ")) {
      if (current.length > 0) messages.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line.startsWith(">From ") ? line.slice(1) : line);
  }
  if (current.length > 0) messages.push(current.join("\n"));
  return messages;
}

/** Thread a message under its nearest known ancestor reference. Cycles and
 *  unknown references leave the message as its own root rather than loop. */
function threadMessages(messages: EmailMessage[]): EmailMessage[][] {
  const byId = new Map<string, EmailMessage>();
  for (const m of messages) if (m.id) byId.set(m.id, m);
  const parent = new Map<EmailMessage, EmailMessage>();
  for (const m of messages) {
    let found: EmailMessage | null = null;
    for (const ref of [...m.references].reverse()) {
      const candidate = byId.get(ref);
      if (candidate && candidate !== m) {
        found = candidate;
        break;
      }
    }
    if (found) parent.set(m, found);
  }
  const rootOf = (m: EmailMessage): EmailMessage => {
    const seen = new Set<EmailMessage>();
    let cur = m;
    while (parent.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = parent.get(cur) as EmailMessage;
    }
    return cur;
  };
  const children = new Map<EmailMessage, EmailMessage[]>();
  for (const m of messages) {
    const p = parent.get(m);
    if (!p) continue;
    const siblings = children.get(p) ?? [];
    siblings.push(m);
    children.set(p, siblings);
  }
  const threads: EmailMessage[][] = [];
  const visited = new Set<EmailMessage>();
  for (const m of messages) {
    if (rootOf(m) !== m || visited.has(m)) continue;
    const thread: EmailMessage[] = [];
    const stack = [m];
    while (stack.length > 0) {
      const current = stack.pop() as EmailMessage;
      if (visited.has(current)) continue;
      visited.add(current);
      thread.push(current);
      const kids = children.get(current) ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
    threads.push(thread);
  }
  return threads;
}

/** Strip reply/forward prefixes so a thread heading reads as its subject. */
function threadSubject(subject: string): string {
  return subject.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").trim() || "(no subject)";
}

function renderEmail(messages: EmailMessage[], truncated: boolean): string {
  const lines: string[] = [];
  let chars = 0;
  let stopped = false;
  const add = (line: string): void => {
    if (stopped) return;
    if (chars + line.length + 1 > MAX_EMAIL_CHARS) {
      stopped = true;
      lines.push(`[email truncated at ${MAX_EMAIL_CHARS} characters]`);
      return;
    }
    lines.push(line);
    chars += line.length + 1;
  };
  for (const thread of threadMessages(messages)) {
    add(`# Email thread: ${threadSubject(thread[0].subject)}`);
    thread.forEach((message, i) => {
      add(`## Message ${i + 1}`);
      if (message.date) add(`Date: ${message.date}`);
      if (message.from) add(`From: ${message.from}`);
      if (message.to) add(`To: ${message.to}`);
      add("");
      add(message.body);
      add("");
    });
  }
  if (truncated) lines.push(`[email truncated after ${MAX_EMAIL_MESSAGES} messages]`);
  return lines.join("\n").trim();
}

/**
 * Extract EML or mbox text. Never throws: anything without recognisable
 * email headers returns "", which the lane reads as "use the model pass".
 */
export function extractEmailText(bytes: Uint8Array): string {
  const raw = latin1(bytes);
  const newline = raw.indexOf("\n");
  const firstLine = (newline === -1 ? raw : raw.slice(0, newline)).replace(
    /\r$/,
    "",
  );
  const isMbox = firstLine.startsWith("From ");
  const rawMessages = isMbox ? splitMbox(raw) : [raw];
  const parsed: EmailMessage[] = [];
  for (let i = 0; i < Math.min(rawMessages.length, MAX_EMAIL_MESSAGES); i++) {
    const message = parseMessage(rawMessages[i], i);
    if (message) parsed.push(message);
  }
  if (parsed.length === 0) return "";
  return renderEmail(parsed, isMbox && rawMessages.length > MAX_EMAIL_MESSAGES);
}
