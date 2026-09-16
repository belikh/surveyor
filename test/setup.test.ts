import { describe, it, expect } from "vitest";
import {
  ProviderEntrySchema,
  SetupStateSchema,
  type SetupState,
  validateSetupStep,
} from "../src/lib/setup";

// First-run wizard contract: the installation boots unconfigured; the
// wizard walks keys → corpus → instrument; completion flips the state
// machine to ready; teardown is only reachable with the operator token.

function baseState(): SetupState {
  return SetupStateSchema.parse({
    phase: "welcome",
    providers: [],
    instrument: null,
    installed_at: null,
  });
}

describe("SetupStateSchema", () => {
  it("accepts a fresh unconfigured installation", () => {
    expect(baseState().phase).toBe("welcome");
  });

  it("rejects a ready state without an instrument (phase machine is honest)", () => {
    expect(() =>
      SetupStateSchema.parse({
        phase: "ready",
        providers: [],
        instrument: null,
        installed_at: "2026-09-15T00:00:00Z",
      }),
    ).toThrow();
  });
});

describe("provider entry safety", () => {
  const entry = (over: Record<string, unknown> = {}) => ({
    kind: "openai-compatible",
    label: "c",
    secret_slot: "GROQ_API_KEY",
    model: "m",
    base_url: "https://llm.example/v1",
    ...over,
  });

  it("accepts a provider slot with a public https base URL", () => {
    expect(ProviderEntrySchema.parse(entry()).secret_slot).toBe("GROQ_API_KEY");
  });

  it("rejects installation secret bindings as secret slots", () => {
    for (const slot of [
      "OPERATOR_TOKEN",
      "SERVER_SECRET",
      "ENCRYPTION_KEY",
      "CF_OAUTH_CLIENT_SECRET",
      "TURNSTILE_SECRET",
      "ARBITRARY_KEY",
    ]) {
      expect(() =>
        ProviderEntrySchema.parse(entry({ secret_slot: slot })),
      ).toThrow(/provider key slot/);
    }
  });

  it("rejects loopback, private, link-local and insecure base URLs", () => {
    for (const base_url of [
      "http://127.0.0.1:8101",
      "http://localhost:11434/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://10.0.0.5/v1",
      "https://192.168.1.10/v1",
      "https://[::1]:8080/v1",
      "http://llm.example/v1",
      "https://metadata.google.internal/v1",
    ]) {
      expect(() => ProviderEntrySchema.parse(entry({ base_url }))).toThrow(
        /base URL/,
      );
    }
  });
});

describe("validateSetupStep", () => {
  it("walks welcome → providers → corpus → instrument → ready", () => {
    let s = baseState();
    s = validateSetupStep(s, { kind: "providers", providers: [] });
    expect(s.phase).toBe("corpus");
    s = validateSetupStep(s, {
      kind: "instrument",
      title: "Test survey",
      blurb: "A test",
      consent: "You are anonymous.",
    });
    expect(s.phase).toBe("ready");
    expect(s.instrument?.title).toBe("Test survey");
    expect(s.installed_at).toBeTruthy();
  });

  it("rejects a providers step submitted after the wizard completed", () => {
    let s = baseState();
    s = validateSetupStep(s, { kind: "providers", providers: [] });
    s = validateSetupStep(s, {
      kind: "instrument",
      title: "T",
      blurb: "B",
      consent: "C",
    });
    expect(s.phase).toBe("ready");
    expect(() =>
      validateSetupStep(s, { kind: "providers", providers: [] }),
    ).toThrow(/phase/);
  });
});
