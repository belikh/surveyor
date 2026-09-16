import { describe, it, expect } from "vitest";
import {
  createVaultKit,
  sealText,
  openText,
  accessCode,
  codeHmac,
} from "../src/lib/vault";

describe("vault crypto", () => {
  it("seal/open round-trips with unique IVs", async () => {
    const kit = await createVaultKit("server-secret", "enckey".padEnd(64, "0"));
    const a = await sealText(kit, "hello sources");
    const b = await sealText(kit, "hello sources");
    expect(a).not.toBe(b);
    expect(await openText(kit, a)).toBe("hello sources");
    expect(await openText(kit, b)).toBe("hello sources");
  });

  it("rejects tampered envelopes", async () => {
    const kit = await createVaultKit("server-secret", "enckey".padEnd(64, "0"));
    const a = await sealText(kit, "x");
    await expect(openText(kit, a.slice(0, -2) + "AA")).rejects.toThrow();
  });

  it("mints unambiguous access codes with stable HMACs", async () => {
    const kit = await createVaultKit("server-secret", "enckey".padEnd(64, "0"));
    const code = accessCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(code).not.toMatch(/[01IL]/);
    const h1 = await codeHmac(kit, code);
    const h2 = await codeHmac(kit, code);
    expect(h1).toBe(h2);
    expect(h1.length).toBeGreaterThan(16);
  });
});
