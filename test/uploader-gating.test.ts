import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { UPLOADER_JS } from "../src/frontend/uploader";

// F3 (#66): the corpus uploader disables its Upload and drain controls
// until the operator token is set, instead of firing unauthenticated
// requests that answer a bare 401.

class TextNode {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

class ElementStub {
  tag: string;
  attrs: Record<string, string> = {};
  children: Array<ElementStub | TextNode> = [];
  onclick: ((...args: never[]) => unknown) | null = null;
  value = "";
  textContent = "";
  disabled = false;
  files: Array<{ name: string; type: string }> = [];
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  append(...nodes: unknown[]): this {
    for (const n of nodes) {
      if (n instanceof ElementStub || n instanceof TextNode) {
        this.children.push(n);
      } else if (typeof n === "string") {
        this.children.push(new TextNode(n));
      } else if (n !== undefined && n !== null) {
        this.children.push(new TextNode(String(n)));
      }
    }
    return this;
  }
  appendChild(n: unknown): unknown {
    return this.append(n);
  }
  replaceChildren(...nodes: unknown[]): this {
    this.children = [];
    return this.append(...nodes);
  }
  text(): string {
    const parts: string[] = [this.textContent];
    for (const c of this.children) {
      parts.push(c instanceof ElementStub ? c.text() : c.text);
    }
    return parts.join(" ");
  }
}

function findAll(
  root: ElementStub,
  pred: (n: ElementStub) => boolean,
  out: ElementStub[] = [],
): ElementStub[] {
  if (pred(root)) out.push(root);
  for (const c of root.children) {
    if (c instanceof ElementStub) findAll(c, pred, out);
  }
  return out;
}

async function boot(fetchImpl: (path: string) => Promise<unknown>) {
  const app = new ElementStub("main");
  const calls: string[] = [];
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === "app" ? app : null),
      createElement: (tag: string) => new ElementStub(tag),
    },
    window: {},
    fetch: async (path: string) => {
      calls.push(String(path));
      const body = await fetchImpl(String(path));
      return {
        ok: true,
        json: async () => body,
      };
    },
    Blob,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.createContext(sandbox);
  vm.runInContext(UPLOADER_JS, sandbox);
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return { app, calls, sandbox };
}

describe("uploader operator-token gate (F3)", () => {
  it("starts gated: controls inert, hint shown, no request leaves the page", async () => {
    const { app, calls } = await boot(async () => ({ docs: [] }));
    const buttons = findAll(app, (n) => n.tag === "button");
    const inputs = findAll(app, (n) => n.tag === "input");
    const filePicker = inputs.find((n) => n.attrs.type === "file");
    const upload = buttons.find((n) => n.text().includes("Upload files"));
    expect(filePicker, "file picker exists").toBeTruthy();
    expect(upload, "upload button exists").toBeTruthy();
    expect(filePicker!.disabled).toBe(true);
    expect(upload!.disabled).toBe(true);
    expect(app.text()).toContain("Set the operator token");
    // No unauthenticated write (or even list) left the page.
    expect(calls).toEqual([]);
  });

  it("clicking Upload while gated sends nothing", async () => {
    const { app, calls } = await boot(async () => ({ docs: [] }));
    const buttons = findAll(app, (n) => n.tag === "button");
    const upload = buttons.find((n) => n.text().includes("Upload files"))!;
    await upload.onclick?.();
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls).toEqual([]);
  });

  it("enables the controls once the token is set", async () => {
    const { app, calls } = await boot(async () => ({ docs: [] }));
    const buttons = findAll(app, (n) => n.tag === "button");
    const inputs = findAll(app, (n) => n.tag === "input");
    const tokenInput = inputs.find((n) => n.attrs.type === "password")!;
    const setToken = buttons.find((n) => n.text().includes("Set token"))!;
    tokenInput.value = "op-token";
    setToken.onclick?.();
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const buttons2 = findAll(app, (n) => n.tag === "button");
    const inputs2 = findAll(app, (n) => n.tag === "input");
    const filePicker2 = inputs2.find((n) => n.attrs.type === "file")!;
    const upload2 = buttons2.find((n) => n.text().includes("Upload files"))!;
    expect(filePicker2.disabled).toBe(false);
    expect(upload2.disabled).toBe(false);
    // The only request is the authenticated list after Set token.
    expect(calls).toEqual(["/api/corpus"]);
  });
});
