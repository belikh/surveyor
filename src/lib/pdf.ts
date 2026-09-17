// Dependency-free native PDF text extraction. Digital-text PDFs are read
// directly: indirect objects, Flate content streams, page order, and
// per-font ToUnicode/encoding maps. Encrypted files, scans (no text
// operators), object layouts beyond this subset and malformed bytes yield
// no text, so the lane falls back to the model pass.
//
// Deliberate limits, all of which fall back rather than guess:
// - form XObjects and annotations are not descended into;
// - image filters (DCT/JPX/CCITT) are never decoded;
// - LZW and predictor-carrying streams are refused;
// - Type0 fonts without a ToUnicode map produce no text.

type PdfName = { readonly name: string };
type PdfRef = { readonly num: number; readonly gen: number };
type PdfDict = Map<string, PdfValue>;
type PdfOp = { readonly op: string };
type PdfValue =
  | number
  | boolean
  | null
  | string
  | PdfName
  | PdfValue[]
  | PdfDict
  | PdfRef;

function isName(v: unknown): v is PdfName {
  return (
    typeof v === "object" && v !== null && typeof (v as PdfName).name === "string"
  );
}

function isRef(v: unknown): v is PdfRef {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as PdfRef).num === "number" &&
    typeof (v as PdfRef).gen === "number"
  );
}

function isDict(v: unknown): v is PdfDict {
  return v instanceof Map;
}

function isArray(v: unknown): v is PdfValue[] {
  return Array.isArray(v);
}

function isOp(v: unknown): v is PdfOp {
  return (
    typeof v === "object" && v !== null && typeof (v as PdfOp).op === "string"
  );
}

const isWs = (b: number): boolean =>
  b === 0 || b === 9 || b === 10 || b === 12 || b === 13 || b === 32;

const isDelim = (b: number): boolean =>
  b === 0x28 ||
  b === 0x29 ||
  b === 0x3c ||
  b === 0x3e ||
  b === 0x5b ||
  b === 0x5d ||
  b === 0x7b ||
  b === 0x7d ||
  b === 0x2f ||
  b === 0x25;

const isRegular = (b: number): boolean => !isWs(b) && !isDelim(b);
const isDigit = (b: number | undefined): boolean =>
  b !== undefined && b >= 0x30 && b <= 0x39;

function hexVal(b: number | undefined): number {
  if (b === undefined) return -1;
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  return -1;
}

function bytesToString(codes: number[]): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < codes.length; i += CHUNK) {
    out += String.fromCharCode(...codes.slice(i, i + CHUNK));
  }
  return out;
}

function latin1(data: Uint8Array): string {
  const codes: number[] = new Array(data.length);
  for (let i = 0; i < data.length; i++) codes[i] = data[i];
  return bytesToString(codes);
}

function findBytes(data: Uint8Array, needle: string, from: number): number {
  const n = needle.length;
  outer: for (let i = Math.max(0, from); i <= data.length - n; i++) {
    for (let j = 0; j < n; j++) {
      if (data[i + j] !== needle.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function matchesWord(data: Uint8Array, pos: number, word: string): boolean {
  if (pos + word.length > data.length) return false;
  for (let i = 0; i < word.length; i++) {
    if (data[pos + i] !== word.charCodeAt(i)) return false;
  }
  const after = data[pos + word.length];
  return after === undefined || !isRegular(after);
}

class Bytes {
  pos = 0;
  constructor(readonly data: Uint8Array) {}

  at(i: number): number | undefined {
    return i >= 0 && i < this.data.length ? this.data[i] : undefined;
  }

  peek(): number | undefined {
    return this.at(this.pos);
  }

  skipWs(): void {
    while (this.pos < this.data.length) {
      const c = this.data[this.pos];
      if (isWs(c)) {
        this.pos++;
        continue;
      }
      if (c === 0x25) {
        while (
          this.pos < this.data.length &&
          this.data[this.pos] !== 0x0a &&
          this.data[this.pos] !== 0x0d
        ) {
          this.pos++;
        }
        continue;
      }
      break;
    }
  }
}

function readWord(b: Bytes): string {
  let out = "";
  while (b.pos < b.data.length && isRegular(b.data[b.pos])) {
    out += String.fromCharCode(b.data[b.pos]);
    b.pos++;
  }
  return out;
}

function readInt(b: Bytes): number {
  let s = "";
  const c = b.at(b.pos);
  if (c === 0x2b || c === 0x2d) {
    s += String.fromCharCode(c);
    b.pos++;
  }
  while (isDigit(b.at(b.pos))) {
    s += String.fromCharCode(b.data[b.pos]);
    b.pos++;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function readNumber(b: Bytes): number {
  let s = "";
  const c = b.at(b.pos);
  if (c === 0x2b || c === 0x2d) {
    s += String.fromCharCode(c);
    b.pos++;
  }
  while (b.pos < b.data.length) {
    const d = b.data[b.pos];
    if ((d >= 0x30 && d <= 0x39) || d === 0x2e) {
      s += String.fromCharCode(d);
      b.pos++;
      continue;
    }
    break;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function parseName(b: Bytes): PdfName {
  b.pos++;
  let out = "";
  while (b.pos < b.data.length) {
    const c = b.data[b.pos];
    if (!isRegular(c)) break;
    b.pos++;
    if (c === 0x23) {
      const hi = hexVal(b.at(b.pos));
      const lo = hexVal(b.at(b.pos + 1));
      if (hi >= 0 && lo >= 0) {
        out += String.fromCharCode(hi * 16 + lo);
        b.pos += 2;
        continue;
      }
    }
    out += String.fromCharCode(c);
  }
  return { name: out };
}

function parseLiteralString(b: Bytes): string {
  b.pos++;
  const codes: number[] = [];
  let depth = 1;
  while (b.pos < b.data.length) {
    const c = b.data[b.pos++];
    if (c === 0x5c) {
      const e = b.at(b.pos);
      if (e === undefined) break;
      b.pos++;
      switch (e) {
        case 0x6e:
          codes.push(10);
          break;
        case 0x72:
          codes.push(13);
          break;
        case 0x74:
          codes.push(9);
          break;
        case 0x62:
          codes.push(8);
          break;
        case 0x66:
          codes.push(12);
          break;
        case 0x28:
        case 0x29:
        case 0x5c:
          codes.push(e);
          break;
        case 0x0d:
          if (b.at(b.pos) === 0x0a) b.pos++;
          break;
        case 0x0a:
          break;
        default:
          if (e >= 0x30 && e <= 0x37) {
            let oct = e - 0x30;
            for (let k = 0; k < 2; k++) {
              const d = b.at(b.pos);
              if (d === undefined || d < 0x30 || d > 0x37) break;
              oct = oct * 8 + (d - 0x30);
              b.pos++;
            }
            codes.push(oct & 0xff);
          } else {
            codes.push(e);
          }
      }
      continue;
    }
    if (c === 0x28) {
      depth++;
      codes.push(c);
      continue;
    }
    if (c === 0x29) {
      depth--;
      if (depth === 0) break;
      codes.push(c);
      continue;
    }
    codes.push(c);
  }
  return bytesToString(codes);
}

function parseHexString(b: Bytes, terminator = 0x3e): string {
  b.pos++;
  const codes: number[] = [];
  let hi = -1;
  while (b.pos < b.data.length) {
    const c = b.data[b.pos++];
    if (c === terminator) break;
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) {
      hi = v;
    } else {
      codes.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) codes.push(hi * 16);
  return bytesToString(codes);
}

function parseNumberOrRef(b: Bytes): PdfValue {
  const value = readNumber(b);
  if (Number.isInteger(value)) {
    const save = b.pos;
    b.skipWs();
    if (isDigit(b.peek())) {
      const gen = readInt(b);
      const after = b.pos;
      b.skipWs();
      if (b.at(b.pos) === 0x52 && !isRegular(b.at(b.pos + 1) ?? 0)) {
        b.pos++;
        return { num: value, gen };
      }
      b.pos = after;
    }
    b.pos = save;
  }
  return value;
}

function parseArray(b: Bytes): PdfValue[] {
  const out: PdfValue[] = [];
  b.pos++;
  while (b.pos < b.data.length) {
    b.skipWs();
    if (b.at(b.pos) === 0x5d) {
      b.pos++;
      break;
    }
    const before = b.pos;
    const value = parseValue(b);
    if (value === undefined) {
      b.pos = before + 1;
      continue;
    }
    out.push(value);
  }
  return out;
}

function parseDict(b: Bytes): PdfDict {
  const dict: PdfDict = new Map();
  b.pos += 2;
  while (b.pos < b.data.length) {
    b.skipWs();
    if (b.at(b.pos) === 0x3e && b.at(b.pos + 1) === 0x3e) {
      b.pos += 2;
      break;
    }
    const before = b.pos;
    const key = parseValue(b);
    if (!isName(key)) {
      b.pos = before + 1;
      continue;
    }
    const value = parseValue(b);
    if (value === undefined) {
      dict.set(key.name, null);
      break;
    }
    dict.set(key.name, value);
  }
  return dict;
}

function parseValue(b: Bytes): PdfValue | undefined {
  b.skipWs();
  const c = b.peek();
  if (c === undefined) return undefined;
  if (c === 0x2f) return parseName(b);
  if (c === 0x28) return parseLiteralString(b);
  if (c === 0x3c) {
    if (b.at(b.pos + 1) === 0x3c) return parseDict(b);
    return parseHexString(b);
  }
  if (c === 0x5b) return parseArray(b);
  if (c === 0x2b || c === 0x2d || c === 0x2e || (c >= 0x30 && c <= 0x39)) {
    return parseNumberOrRef(b);
  }
  const word = readWord(b);
  if (word === "true") return true;
  if (word === "false") return false;
  if (word === "null") return null;
  return undefined;
}

interface PdfObject {
  num: number;
  gen: number;
  dict: PdfDict;
  raw?: Uint8Array;
}

function objectHeaderAt(
  data: Uint8Array,
  at: number,
): { num: number; gen: number } | null {
  let p = at - 1;
  if (p < 0 || !isWs(data[p])) return null;
  while (p >= 0 && isWs(data[p])) p--;
  const genEnd = p;
  while (p >= 0 && isDigit(data[p])) p--;
  if (genEnd === p) return null;
  let gen = 0;
  for (let i = p + 1; i <= genEnd; i++) gen = gen * 10 + (data[i] - 0x30);
  if (p >= 0 && !isWs(data[p])) return null;
  while (p >= 0 && isWs(data[p])) p--;
  const numEnd = p;
  while (p >= 0 && isDigit(data[p])) p--;
  if (numEnd === p) return null;
  if (p >= 0 && isRegular(data[p])) return null;
  let num = 0;
  for (let i = p + 1; i <= numEnd; i++) num = num * 10 + (data[i] - 0x30);
  return { num, gen };
}

/** Sequential scan for `N G obj ... endobj`; streams are sliced whole. */
export function scanObjects(data: Uint8Array): Map<string, PdfObject> {
  const objects = new Map<string, PdfObject>();
  let pos = 0;
  while (true) {
    const at = findBytes(data, "obj", pos);
    if (at < 0) break;
    pos = at + 3;
    const header = objectHeaderAt(data, at);
    if (!header) continue;
    const b = new Bytes(data);
    b.pos = at + 3;
    let value: PdfValue | undefined;
    try {
      value = parseValue(b);
    } catch {
      continue;
    }
    if (!isDict(value)) continue;
    const obj: PdfObject = { num: header.num, gen: header.gen, dict: value };
    b.skipWs();
    if (matchesWord(data, b.pos, "stream")) {
      b.pos += 6;
      if (b.at(b.pos) === 0x0d) b.pos++;
      if (b.at(b.pos) === 0x0a) b.pos++;
      const start = b.pos;
      const length = value.get("Length");
      let end = -1;
      if (typeof length === "number" && length >= 0 && start + length <= data.length) {
        let q = start + length;
        if (data[q] === 0x0d) q++;
        if (data[q] === 0x0a) q++;
        if (matchesWord(data, q, "endstream")) end = start + length;
      }
      if (end < 0) {
        const found = findBytes(data, "endstream", start);
        if (found < 0) continue;
        end = found;
        if (end > start && data[end - 1] === 0x0a) end--;
        if (end > start && data[end - 1] === 0x0d) end--;
      }
      obj.raw = data.subarray(start, end);
      pos = end;
    }
    objects.set(`${obj.num} ${obj.gen}`, obj);
  }
  return objects;
}

function resolve(value: unknown, objects: Map<string, PdfObject>): unknown {
  let current = value;
  for (let i = 0; i < 64; i++) {
    if (!isRef(current)) return current;
    const obj = objects.get(`${current.num} ${current.gen}`);
    if (!obj) return null;
    current = obj.dict;
  }
  return current;
}

function resolveDict(
  value: unknown,
  objects: Map<string, PdfObject>,
): PdfDict | null {
  const r = resolve(value, objects);
  return isDict(r) ? r : null;
}

function nameOf(value: unknown): string | null {
  return isName(value) ? value.name : null;
}

async function inflate(data: Uint8Array, raw: boolean): Promise<Uint8Array> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream(raw ? "deflate-raw" : "deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function flateDecode(data: Uint8Array): Promise<Uint8Array> {
  try {
    return await inflate(data, false);
  } catch {
    // A handful of writers emit headerless deflate; accept it.
    return await inflate(data, true);
  }
}

function asciiHexDecode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 0x3e) break;
    const v = hexVal(c);
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return new Uint8Array(out);
}

function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let tuple: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (isWs(c)) continue;
    if (c === 0x7e) break;
    if (c === 0x7a && tuple.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 0x21 || c > 0x75) throw new Error("bad ASCII85 data");
    tuple.push(c - 0x21);
    if (tuple.length === 5) {
      let value = 0;
      for (const d of tuple) value = value * 85 + d;
      out.push(
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      );
      tuple = [];
    }
  }
  if (tuple.length > 1) {
    const n = tuple.length;
    while (tuple.length < 5) tuple.push(84);
    let value = 0;
    for (const d of tuple) value = value * 85 + d;
    const bytes = [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    out.push(...bytes.slice(0, n - 1));
  }
  return new Uint8Array(out);
}

async function decodeStream(
  obj: PdfObject,
  objects: Map<string, PdfObject>,
): Promise<Uint8Array | null> {
  if (!obj.raw) return null;
  const filters = resolve(obj.dict.get("Filter"), objects);
  const list = isArray(filters) ? filters : filters === undefined ? [] : [filters];
  let data = obj.raw;
  for (const filter of list) {
    const name = nameOf(resolve(filter, objects));
    if (name === "FlateDecode" || name === "Fl") {
      data = await flateDecode(data);
    } else if (name === "ASCIIHexDecode" || name === "AHx") {
      data = asciiHexDecode(data);
    } else if (name === "ASCII85Decode" || name === "A85") {
      data = ascii85Decode(data);
    } else if (name === "Crypt") {
      throw new Error("encrypted PDF stream");
    } else if (name) {
      throw new Error(`unsupported PDF filter ${name}`);
    }
  }
  return data;
}

/** Expand /Type /ObjStm containers into their member objects. */
async function expandObjectStreams(objects: Map<string, PdfObject>): Promise<void> {
  const snapshot = [...objects.values()];
  for (const obj of snapshot) {
    if (nameOf(resolve(obj.dict.get("Type"), objects)) !== "ObjStm") continue;
    const n = obj.dict.get("N");
    const first = obj.dict.get("First");
    if (typeof n !== "number" || typeof first !== "number" || n <= 0) continue;
    let data: Uint8Array;
    try {
      const decoded = await decodeStream(obj, objects);
      if (!decoded) continue;
      data = decoded;
    } catch {
      continue;
    }
    const header = new Bytes(data);
    const pairs: Array<{ num: number; off: number }> = [];
    for (let i = 0; i < n; i++) {
      header.skipWs();
      const num = readInt(header);
      header.skipWs();
      const off = readInt(header);
      pairs.push({ num, off });
    }
    for (const { num, off } of pairs) {
      const key = `${num} 0`;
      if (objects.has(key)) continue;
      const b = new Bytes(data);
      b.pos = first + off;
      try {
        const value = parseValue(b);
        if (isDict(value)) objects.set(key, { num, gen: 0, dict: value });
      } catch {
        // Skip an unreadable member; others may still resolve.
      }
    }
  }
}

interface CMap {
  map: Map<number, string>;
  codeLen: number;
}

function hexTokenToCodes(token: string): number[] {
  const hex = token.slice(1, -1).replace(/[^0-9a-fA-F]/g, "");
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16));
  }
  if (hex.length % 2 === 1) out.push(parseInt(hex[hex.length - 1] + "0", 16));
  return out;
}

function codesToNum(codes: number[]): number {
  let n = 0;
  for (const c of codes) n = (n << 8) | c;
  return n;
}

function utf16be(codes: number[]): string {
  let out = "";
  for (let i = 0; i + 1 < codes.length; i += 2) {
    out += String.fromCharCode((codes[i] << 8) | codes[i + 1]);
  }
  if (codes.length % 2 === 1) out += String.fromCharCode(codes[codes.length - 1]);
  return out;
}

function parseToUnicode(data: Uint8Array): CMap {
  const text = latin1(data);
  const tokens =
    text.match(/<[0-9A-Fa-f\s]*>|\[|\]|[^\s<>\[\]]+/g) ?? [];
  const map = new Map<number, string>();
  let codeLen = 1;
  let i = 0;
  const readHex = (): number[] | null => {
    const token = tokens[i];
    if (!token || token[0] !== "<") return null;
    i++;
    const codes = hexTokenToCodes(token);
    return codes.length > 0 ? codes : null;
  };
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "beginbfchar") {
      i++;
      while (i < tokens.length && tokens[i] !== "endbfchar") {
        const src = readHex();
        if (!src) break;
        const dst = readHex();
        if (!dst) break;
        map.set(codesToNum(src), utf16be(dst));
        codeLen = Math.max(codeLen, Math.min(2, src.length));
      }
      continue;
    }
    if (token === "beginbfrange") {
      i++;
      while (i < tokens.length && tokens[i] !== "endbfrange") {
        const lo = readHex();
        const hi = readHex();
        if (!lo || !hi) break;
        const loNum = codesToNum(lo);
        const hiNum = codesToNum(hi);
        codeLen = Math.max(codeLen, Math.min(2, lo.length));
        if (tokens[i] === "[") {
          i++;
          const dsts: number[][] = [];
          while (i < tokens.length && tokens[i] !== "]") {
            const dst = readHex();
            if (!dst) {
              i++;
              continue;
            }
            dsts.push(dst);
          }
          if (tokens[i] === "]") i++;
          for (let code = loNum; code <= hiNum; code++) {
            const dst = dsts[code - loNum];
            if (!dst) break;
            map.set(code, utf16be(dst));
          }
        } else {
          const dst = readHex();
          if (!dst) break;
          if (dst.length > 2) {
            map.set(loNum, utf16be(dst));
          } else {
            const base = codesToNum(dst);
            for (let code = loNum; code <= hiNum; code++) {
              map.set(code, String.fromCodePoint(base + (code - loNum)));
            }
          }
        }
      }
      continue;
    }
    i++;
  }
  return { map, codeLen };
}

const CP1252_HIGH: Record<number, string> = {
  0x80: "\u20ac",
  0x82: "\u201a",
  0x83: "\u0192",
  0x84: "\u201e",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02c6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017d",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201c",
  0x94: "\u201d",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02dc",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203a",
  0x9c: "\u0153",
  0x9e: "\u017e",
  0x9f: "\u0178",
};

function cp1252(code: number): string {
  if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
  if (code >= 0xa0 && code <= 0xff) return String.fromCharCode(code);
  return CP1252_HIGH[code] ?? "";
}

const GLYPH_NAMES: Record<string, string> = {
  space: " ",
  exclam: "!",
  quotedbl: '"',
  numbersign: "#",
  dollar: "$",
  percent: "%",
  ampersand: "&",
  quotesingle: "'",
  parenleft: "(",
  parenright: ")",
  asterisk: "*",
  plus: "+",
  comma: ",",
  hyphen: "-",
  period: ".",
  slash: "/",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  colon: ":",
  semicolon: ";",
  less: "<",
  equal: "=",
  greater: ">",
  question: "?",
  at: "@",
  bracketleft: "[",
  backslash: "\\",
  bracketright: "]",
  asciicircum: "^",
  underscore: "_",
  grave: "`",
  braceleft: "{",
  bar: "|",
  braceright: "}",
  asciitilde: "~",
  quoteleft: "\u2018",
  quoteright: "\u2019",
  quotedblleft: "\u201c",
  quotedblright: "\u201d",
  endash: "\u2013",
  emdash: "\u2014",
  bullet: "\u2022",
  ellipsis: "\u2026",
};

function glyphToChar(name: string): string | null {
  if (name.length === 1) return name;
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1], 16));
  return GLYPH_NAMES[name] ?? null;
}

interface FontDecoder {
  decode(codeBytes: string): string;
  /** Advance width of a code string, in thousandths of an em. */
  width(codeBytes: string): number;
}

interface SimpleWidths {
  firstChar: number;
  widths: number[];
  missing: number;
}

function readSimpleWidths(
  font: PdfDict,
  objects: Map<string, PdfObject>,
): SimpleWidths | null {
  const firstChar = resolve(font.get("FirstChar"), objects);
  const widthsValue = resolve(font.get("Widths"), objects);
  if (typeof firstChar !== "number" || !isArray(widthsValue)) return null;
  const widths = widthsValue.map((v) => {
    const n = resolve(v, objects);
    return typeof n === "number" ? n : 0;
  });
  let missing = 500;
  const descriptor = resolveDict(font.get("FontDescriptor"), objects);
  const missingWidth = descriptor
    ? resolve(descriptor.get("MissingWidth"), objects)
    : null;
  if (typeof missingWidth === "number") missing = missingWidth;
  return { firstChar, widths, missing };
}

function readCidWidths(
  font: PdfDict,
  objects: Map<string, PdfObject>,
): ((code: number) => number) | null {
  const descendants = resolve(font.get("DescendantFonts"), objects);
  const cid = isArray(descendants)
    ? resolveDict(descendants[0], objects)
    : null;
  if (!cid) return null;
  const dw = resolve(cid.get("DW"), objects);
  const defaultWidth = typeof dw === "number" ? dw : 1000;
  const map = new Map<number, number>();
  const w = resolve(cid.get("W"), objects);
  if (isArray(w)) {
    let i = 0;
    while (i < w.length) {
      const start = resolve(w[i], objects);
      if (typeof start !== "number") {
        i++;
        continue;
      }
      const second = resolve(w[i + 1], objects);
      if (isArray(second)) {
        for (let k = 0; k < second.length; k++) {
          const n = resolve(second[k], objects);
          if (typeof n === "number") map.set(start + k, n);
        }
        i += 2;
        continue;
      }
      const third = resolve(w[i + 2], objects);
      if (typeof second === "number" && typeof third === "number") {
        for (let code = start; code <= second && code - start < 65536; code++) {
          map.set(code, third);
        }
      }
      i += 3;
    }
  }
  return (code: number) => map.get(code) ?? defaultWidth;
}

function buildWidthFn(
  codeLen: 1 | 2,
  simple: SimpleWidths | null,
  cid: ((code: number) => number) | null,
): (codeBytes: string) => number {
  const widthOf = (code: number): number => {
    if (cid) return cid(code);
    if (simple) {
      const index = code - simple.firstChar;
      if (index >= 0 && index < simple.widths.length) return simple.widths[index];
      return simple.missing;
    }
    return 500;
  };
  return (codeBytes: string): number => {
    let total = 0;
    if (codeLen === 2) {
      for (let i = 0; i + 1 < codeBytes.length; i += 2) {
        total += widthOf((codeBytes.charCodeAt(i) << 8) | codeBytes.charCodeAt(i + 1));
      }
    } else {
      for (let i = 0; i < codeBytes.length; i++) {
        total += widthOf(codeBytes.charCodeAt(i));
      }
    }
    return total;
  };
}

function buildCmapDecoder(
  cmap: CMap,
  fallbackSimple: boolean,
): Pick<FontDecoder, "decode"> {
  return {
    decode(codeBytes: string): string {
      let out = "";
      let i = 0;
      while (i < codeBytes.length) {
        if (cmap.codeLen === 2 && i + 1 < codeBytes.length) {
          const two =
            (codeBytes.charCodeAt(i) << 8) | codeBytes.charCodeAt(i + 1);
          const mapped = cmap.map.get(two);
          if (mapped !== undefined) {
            out += mapped;
            i += 2;
            continue;
          }
          const one = cmap.map.get(codeBytes.charCodeAt(i));
          if (one !== undefined) {
            out += one;
            i += 1;
            continue;
          }
          if (fallbackSimple) out += cp1252(codeBytes.charCodeAt(i));
          i += 2;
        } else {
          const code = codeBytes.charCodeAt(i);
          const mapped = cmap.map.get(code);
          out += mapped ?? (fallbackSimple ? cp1252(code) : "");
          i += 1;
        }
      }
      return out;
    },
  };
}

function encodingDifferences(
  font: PdfDict,
  objects: Map<string, PdfObject>,
): Map<number, string> {
  const map = new Map<number, string>();
  const encoding = resolve(font.get("Encoding"), objects);
  if (!isDict(encoding)) return map;
  const differences = encoding.get("Differences");
  if (!isArray(differences)) return map;
  let code = 0;
  for (const item of differences) {
    if (typeof item === "number") {
      code = item;
    } else if (isName(item)) {
      const ch = glyphToChar(item.name);
      if (ch) map.set(code, ch);
      code++;
    }
  }
  return map;
}

async function buildFontDecoder(
  font: PdfDict,
  objects: Map<string, PdfObject>,
): Promise<FontDecoder> {
  const subtype = nameOf(resolve(font.get("Subtype"), objects)) ?? "";
  const type0 = subtype === "Type0";
  const simpleWidths = type0 ? null : readSimpleWidths(font, objects);
  const cidWidths = type0 ? readCidWidths(font, objects) : null;
  const toUnicodeValue = font.get("ToUnicode");
  const toUnicodeObj = isRef(toUnicodeValue)
    ? objects.get(`${toUnicodeValue.num} ${toUnicodeValue.gen}`)
    : undefined;
  if (toUnicodeObj?.raw) {
    try {
      const data = await decodeStream(toUnicodeObj, objects);
      if (data) {
        const cmap = parseToUnicode(data);
        if (cmap.map.size > 0) {
          const base = buildCmapDecoder(cmap, !type0);
          return {
            decode: base.decode,
            width: buildWidthFn(cmap.codeLen === 2 ? 2 : 1, simpleWidths, cidWidths),
          };
        }
      }
    } catch {
      // Fall through to the encoding-based decoder.
    }
  }
  if (type0) {
    return { decode: () => "", width: buildWidthFn(2, null, cidWidths) };
  }
  const differences = encodingDifferences(font, objects);
  return {
    decode(codeBytes: string): string {
      let out = "";
      for (let i = 0; i < codeBytes.length; i++) {
        const code = codeBytes.charCodeAt(i);
        out += differences.get(code) ?? cp1252(code);
      }
      return out;
    },
    width: buildWidthFn(1, simpleWidths, null),
  };
}

function numAt(stack: PdfValue[], fromEnd: number): number | null {
  const v = stack[stack.length + fromEnd];
  return typeof v === "number" ? v : null;
}

function stringAt(stack: PdfValue[], fromEnd: number): string | null {
  const v = stack[stack.length + fromEnd];
  return typeof v === "string" ? v : null;
}

/** Walk one decoded content stream, tracking text position and font map. */
export function contentToText(
  data: Uint8Array,
  fonts: Map<string, FontDecoder>,
): string {
  const b = new Bytes(data);
  const stack: PdfValue[] = [];
  let out = "";
  let font: FontDecoder | null = null;
  let fontSize = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let horizScale = 1;
  let lineX = 0;
  let lineY = 0;
  let penX = 0;
  const newline = () => {
    if (out && !out.endsWith("\n")) out += "\n";
  };
  const space = () => {
    if (out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
  };
  const advance = (s: string) => {
    const width = font ? font.width(s) : s.length * 500;
    let spaces = 0;
    for (let i = 0; i < s.length; i++) if (s[i] === " ") spaces++;
    penX +=
      (width / 1000) * fontSize * horizScale +
      charSpacing * horizScale * s.length +
      wordSpacing * horizScale * spaces;
  };
  const show = (s: string | null) => {
    if (s === null) return;
    out += font ? font.decode(s) : s;
    advance(s);
  };

  while (b.pos < b.data.length) {
    b.skipWs();
    if (b.pos >= b.data.length) break;
    const c = b.data[b.pos];
    let value: PdfValue | PdfOp | undefined;
    if (
      c === 0x2f ||
      c === 0x28 ||
      c === 0x5b ||
      c === 0x3c ||
      c === 0x2b ||
      c === 0x2d ||
      c === 0x2e ||
      (c >= 0x30 && c <= 0x39)
    ) {
      value = parseValue(b);
    } else {
      value = { op: readWord(b) };
    }
    if (value === undefined || (isOp(value) && value.op === "")) {
      b.pos++;
      continue;
    }
    if (!isOp(value)) {
      stack.push(value);
      continue;
    }
    switch (value.op) {
      case "Tf": {
        const size = numAt(stack, -1);
        const name = stack[stack.length - 2];
        if (size !== null) fontSize = Math.max(1, Math.abs(size));
        font = isName(name) ? fonts.get(name.name) ?? null : null;
        break;
      }
      case "Td":
      case "TD": {
        const ty = numAt(stack, -1) ?? 0;
        const tx = numAt(stack, -2) ?? 0;
        lineX += tx;
        lineY += ty;
        // A positive gap against where the previous run ended is a word
        // break. Glyph widths make this exact for PDFs that position every
        // run, so explicit space glyphs are not doubled.
        if (Math.abs(ty) > fontSize * 0.25) {
          newline();
        } else if (lineX - penX > fontSize * 0.2) {
          space();
        }
        penX = lineX;
        break;
      }
      case "Tm": {
        const f = numAt(stack, -1);
        const e = numAt(stack, -2);
        if (e !== null) {
          if (f !== null && Math.abs(f - lineY) > fontSize * 0.25) {
            newline();
          } else if (e - penX > fontSize * 0.2) {
            space();
          }
          lineX = e;
          penX = e;
          if (f !== null) lineY = f;
        }
        break;
      }
      case "T*": {
        lineY -= leading;
        if (Math.abs(leading) > fontSize * 0.25) newline();
        penX = lineX;
        break;
      }
      case "TL": {
        const l = numAt(stack, -1);
        if (l !== null) leading = l;
        break;
      }
      case "Tc": {
        const sp = numAt(stack, -1);
        if (sp !== null) charSpacing = sp;
        break;
      }
      case "Tw": {
        const sp = numAt(stack, -1);
        if (sp !== null) wordSpacing = sp;
        break;
      }
      case "Tz": {
        const scale = numAt(stack, -1);
        if (scale !== null) horizScale = scale / 100;
        break;
      }
      case "Tj":
        show(stringAt(stack, -1));
        break;
      case "'":
        newline();
        penX = lineX;
        show(stringAt(stack, -1));
        break;
      case '"':
        newline();
        penX = lineX;
        show(stringAt(stack, -1));
        break;
      case "TJ": {
        const arr = stack[stack.length - 1];
        if (isArray(arr)) {
          for (const item of arr) {
            if (typeof item === "number") {
              const gap = (-item / 1000) * fontSize * horizScale;
              penX += gap;
              if (gap > fontSize * 0.2) space();
            } else if (typeof item === "string") {
              show(item);
            }
          }
        }
        break;
      }
      default:
        break;
    }
    stack.length = 0;
  }
  return out;
}

interface PdfPage {
  dict: PdfDict;
  resources: PdfDict | null;
}

async function collectPages(objects: Map<string, PdfObject>): Promise<PdfPage[]> {
  const pages: PdfPage[] = [];
  let catalog: PdfDict | null = null;
  for (const obj of objects.values()) {
    if (nameOf(resolve(obj.dict.get("Type"), objects)) === "Catalog") {
      catalog = obj.dict;
      break;
    }
  }
  if (catalog) {
    await walkPages(catalog.get("Pages"), null, objects, pages, 0);
  }
  if (pages.length === 0) {
    for (const obj of objects.values()) {
      if (nameOf(resolve(obj.dict.get("Type"), objects)) === "Page") {
        pages.push({
          dict: obj.dict,
          resources: resolveDict(obj.dict.get("Resources"), objects),
        });
      }
    }
  }
  return pages;
}

async function walkPages(
  value: unknown,
  inherited: PdfDict | null,
  objects: Map<string, PdfObject>,
  pages: PdfPage[],
  depth: number,
): Promise<void> {
  if (depth > 64 || pages.length > 10000) return;
  const node = resolveDict(value, objects);
  if (!node) return;
  const type = nameOf(resolve(node.get("Type"), objects));
  const resources =
    resolveDict(node.get("Resources"), objects) ?? inherited;
  if (type === "Page") {
    pages.push({ dict: node, resources });
    return;
  }
  const kids = resolve(node.get("Kids"), objects);
  if (isArray(kids)) {
    for (const kid of kids) {
      await walkPages(kid, resources, objects, pages, depth + 1);
    }
    return;
  }
  if (type !== "Pages") pages.push({ dict: node, resources });
}

async function pageFonts(
  resources: PdfDict | null,
  objects: Map<string, PdfObject>,
): Promise<Map<string, FontDecoder>> {
  const fonts = new Map<string, FontDecoder>();
  const fontDict = resolveDict(resources?.get("Font"), objects);
  if (!fontDict) return fonts;
  for (const [name, value] of fontDict) {
    const font = resolveDict(value, objects);
    if (!font) continue;
    try {
      fonts.set(name, await buildFontDecoder(font, objects));
    } catch {
      // An unreadable font contributes no text; other fonts still do.
    }
  }
  return fonts;
}

async function pageText(
  page: PdfPage,
  objects: Map<string, PdfObject>,
): Promise<string> {
  const fonts = await pageFonts(page.resources, objects);
  const contents = resolve(page.dict.get("Contents"), objects);
  const refs: PdfRef[] = [];
  if (isRef(page.dict.get("Contents"))) {
    refs.push(page.dict.get("Contents") as PdfRef);
  } else if (isArray(contents)) {
    for (const item of contents) if (isRef(item)) refs.push(item);
  }
  const parts: string[] = [];
  for (const ref of refs) {
    const obj = objects.get(`${ref.num} ${ref.gen}`);
    if (!obj?.raw) continue;
    try {
      const data = await decodeStream(obj, objects);
      if (!data) continue;
      const text = contentToText(data, fonts);
      if (text.trim()) parts.push(text);
    } catch {
      // A stream we cannot decode contributes nothing to this page.
    }
  }
  return parts.join("\n");
}

/**
 * Extract the text of a digital PDF. Returns "" when the document is
 * encrypted, carries no text layer, or sits outside the supported subset.
 */
export async function extractPdfText(data: Uint8Array): Promise<string> {
  try {
    if (findBytes(data, "%PDF-", 0) < 0) return "";
    if (findBytes(data, "/Encrypt", 0) >= 0) return "";
    const objects = scanObjects(data);
    if (objects.size === 0) return "";
    await expandObjectStreams(objects);
    const pages = await collectPages(objects);
    const parts: string[] = [];
    for (const page of pages) {
      const text = await pageText(page, objects);
      if (text.trim()) parts.push(text);
    }
    const joined = parts.join("\n").replace(/[ \t]+\n/g, "\n");
    return joined.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    return "";
  }
}
