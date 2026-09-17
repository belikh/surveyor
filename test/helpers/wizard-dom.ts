// Minimal DOM harness for the wizard driver (WIZARD_JS in
// src/frontend/chrome.ts): enough document for render() to draw, with fetch
// stubbed per path, so the fresh-install and failure paths are
// test-verified, not assumed. Not a browser: no layout, no events, no
// navigation, no clicks — render assertions only.

import vm from "node:vm";
import { WIZARD_JS } from "../../src/frontend/chrome";

export interface WizardFetch {
  (path: string, init?: RequestInit): Promise<Response>;
}

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
  text(): string {
    const parts: string[] = [this.textContent];
    for (const c of this.children) {
      parts.push(c instanceof ElementStub ? c.text() : c.text);
    }
    return parts.join(" ");
  }
}

/** Run the driver with stubbed fetch and return the rendered app text. */
export async function renderWizard(fetchImpl: WizardFetch): Promise<string> {
  const app = new ElementStub("main");
  // The shell carries the title as a data attribute (no inline script, so
  // the page honours script-src 'self'). Deliberately no APP_TITLE global:
  // the driver must read it from the DOM, as it must in a real browser.
  app.setAttribute("data-title", "Surveyor — test");
  const sandbox: Record<string, unknown> = {
    document: {
      getElementById: (id: string) => (id === "app" ? app : null),
      createElement: (tag: string) => new ElementStub(tag),
    },
    location: {
      href: "https://wizard.test/",
      hash: "",
      pathname: "/",
      search: "",
    },
    history: { replaceState: () => {} },
    confirm: () => true,
    fetch: fetchImpl,
    crypto: (globalThis as { crypto?: unknown }).crypto,
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
  };
  vm.createContext(sandbox);
  vm.runInContext(WIZARD_JS, sandbox);
  // Flush the driver's promise chain (fetch stubs resolve immediately).
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return app.text();
}
