// Minimal DOM harness for the console driver (CONSOLE_JS in
// src/frontend/console.ts), generalising the wizard's harness (#67). Enough
// document for render() to draw: createElement, append/remove/replaceChildren,
// attributes, inputs, and a per-path fetch stub, so gating, section
// rendering, confirmations and error states are test-verified, not assumed.
// Not a browser: no layout, no events beyond onclick, no navigation.

import vm from "node:vm";
import { CONSOLE_JS } from "../../src/frontend/console";

export interface StubResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Responder = (
  path: string,
  init?: RequestInit,
) => StubResponse | Promise<StubResponse>;

export interface Call {
  path: string;
  init?: RequestInit;
}

export class TextNode {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export class ElementStub {
  tag: string;
  attrs: Record<string, string> = {};
  children: Array<ElementStub | TextNode> = [];
  onclick: ((...args: never[]) => unknown) | null = null;
  value = "";
  textContent = "";
  disabled = false;
  checked = false;
  files: Array<{ name: string; type: string }> = [];
  parent: ElementStub | null = null;
  constructor(tag: string) {
    this.tag = tag;
  }
  setAttribute(k: string, v: string): void {
    this.attrs[k] = v;
  }
  getAttribute(k: string): string | null {
    return Object.hasOwn(this.attrs, k) ? this.attrs[k] : null;
  }
  append(...nodes: unknown[]): this {
    for (const n of nodes) {
      if (n instanceof ElementStub || n instanceof TextNode) {
        if (n instanceof ElementStub) n.parent = this;
        this.children.push(n);
      } else if (n !== undefined && n !== null) {
        this.children.push(new TextNode(String(n)));
      }
    }
    return this;
  }
  replaceChildren(...nodes: unknown[]): this {
    this.children = [];
    return this.append(...nodes);
  }
  remove(): void {
    if (this.parent) {
      this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    }
  }
  text(): string {
    const parts: string[] = [this.textContent];
    for (const c of this.children) {
      parts.push(c instanceof ElementStub ? c.text() : c.text);
    }
    return parts.join(" ");
  }
}

export function findAll(
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

export interface ConsoleHarness {
  app: ElementStub;
  calls: Call[];
  alerts: string[];
  confirms: string[];
  tokenInputs: () => ElementStub[];
  setToken: (value: string) => Promise<void>;
  click: (label: string) => Promise<void>;
  flush: () => Promise<void>;
  text: () => string;
  buttons: () => ElementStub[];
  inputs: () => ElementStub[];
  /** Change the hash and fire the driver's hashchange listener. */
  navigate: (hash: string) => Promise<void>;
  /** Replace the confirm/alert handler (auto-accept by default). */
  setDialogHandler: (
    handler: (kind: "confirm" | "alert", message: string) => boolean,
  ) => void;
}

export interface BootOptions {
  hash?: string;
  cfFragment?: string;
  confirm?: (message: string) => boolean;
}

/** Boot the console driver with stubbed fetch and return handles to the DOM. */
export async function bootConsole(
  responder: Responder,
  opts: BootOptions = {},
): Promise<ConsoleHarness> {
  const app = new ElementStub("main");
  const head = new ElementStub("head");
  const calls: Call[] = [];
  const alerts: string[] = [];
  const confirms: string[] = [];
  const hashListeners: Array<() => void> = [];
  const dialogHolder = {
    handler: (kind: "confirm" | "alert", message: string): boolean => {
      if (opts.confirm) return opts.confirm(message);
      return true;
    },
  };
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === "app" ? app : null),
      createElement: (tag: string) => new ElementStub(tag),
      head,
    },
    window: {
      addEventListener: (type: string, fn: () => void) => {
        if (type === "hashchange") hashListeners.push(fn);
      },
    },
    location: {
      href: "https://survey.example/console",
      origin: "https://survey.example",
      hash: opts.hash ?? "",
      pathname: "/console",
      search: "",
    },
    history: { replaceState: () => {} },
    confirm: (message: string) => {
      confirms.push(message);
      return dialogHolder.handler("confirm", message);
    },
    alert: (message: string) => {
      alerts.push(String(message));
      dialogHolder.handler("alert", String(message));
    },
    fetch: async (path: string, init?: RequestInit) => {
      calls.push({ path: String(path), init });
      const stub = await responder(String(path), init);
      const status = stub.status ?? 200;
      return {
        ok: status < 400,
        status,
        headers: {
          get: (name: string) =>
            (stub.headers ?? {})[name.toLowerCase()] ?? null,
        },
        json: async () => stub.body,
        text: async () => JSON.stringify(stub.body),
        blob: async () => new Blob([JSON.stringify(stub.body)]),
      };
    },
    confirmMessage: "",
    Blob,
    URL: {
      createObjectURL: () => "blob:stub",
      revokeObjectURL: () => {},
    },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    // The status poll never fires in the harness: section refreshes are
    // explicit and tests must not race an interval.
    setInterval: () => 0,
  };
  if (opts.cfFragment) {
    (sandbox.location as { hash: string }).hash = opts.cfFragment;
  }
  vm.createContext(sandbox);
  vm.runInContext(CONSOLE_JS, sandbox);
  const flush = async () => {
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  await flush();
  const buttons = () => findAll(app, (n) => n.tag === "button");
  const inputs = () => findAll(app, (n) => n.tag === "input");
  const byLabel = (label: string) =>
    buttons().find((b) => b.text().includes(label));
  return {
    app,
    calls,
    alerts,
    confirms,
    tokenInputs: () => inputs().filter((i) => i.attrs.type === "password"),
    setToken: async (value: string) => {
      const tokenInput = inputs().find(
        (i) => i.attrs.type === "password" && (i.attrs.placeholder || "").includes("Operator token"),
      );
      if (!tokenInput) throw new Error("operator token input not found");
      const set = byLabel("Set token");
      if (!set) throw new Error("Set token button not found");
      tokenInput.value = value;
      set.onclick?.();
      await flush();
    },
    click: async (label: string) => {
      const b = byLabel(label);
      if (!b) throw new Error("button not found: " + label);
      await b.onclick?.();
      await flush();
    },
    flush,
    text: () => app.text(),
    buttons,
    inputs,
    navigate: async (hash: string) => {
      (sandbox.location as { hash: string }).hash = hash;
      for (const fn of hashListeners) fn();
      await flush();
    },
    setDialogHandler: (handler) => {
      dialogHolder.handler = handler;
    },
  };
}
