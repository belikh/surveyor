import { describe, it, expect } from "vitest";
import {
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
