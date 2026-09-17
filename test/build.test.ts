import { describe, it, expect } from "vitest";
import app from "../src/index";
import { buildInfo } from "../src/lib/build";
import { FakeD1 } from "./helpers/d1";

function makeEnv(extra: Record<string, unknown> = {}) {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
    ...extra,
  };
}

async function callApp(env: Record<string, unknown>, path: string) {
  return app.fetch(
    new Request(`https://surveyor.example${path}`),
    env as never,
  );
}

// F4 (#63): the install status names the deployed build, so "is the fix
// deployed?" is a one-line check. Local/dev builds say so honestly.
describe("deployed build identity in install status (F4)", () => {
  it("carries a build field with a commit string and local flag", async () => {
    const body = (await (
      await callApp(makeEnv(), "/api/status")
    ).json()) as {
      build: { commit: unknown; local: unknown };
    };
    expect(typeof body.build.commit).toBe("string");
    expect((body.build.commit as string).length).toBeGreaterThan(0);
    expect(typeof body.build.local).toBe("boolean");
  });

  it("is honest about local builds in the test bundle", () => {
    // No --define in vitest, so the fallback must say local.
    const info = buildInfo();
    expect(info.commit).toBe("local");
    expect(info.local).toBe(true);
  });

  it("names the build while unprovisioned too", async () => {
    const env = { DB: new FakeD1() as never };
    const body = (await (
      await callApp(env, "/api/status")
    ).json()) as {
      provisioned: boolean;
      build: { commit: unknown };
    };
    expect(body.provisioned).toBe(false);
    expect(typeof body.build.commit).toBe("string");
  });
});
