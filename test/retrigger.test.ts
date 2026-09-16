import { describe, it, expect } from "vitest";
import { boot } from "../src/state";
import { sealText, type VaultKit } from "../src/lib/vault";
import {
  retriggerOnCompletion,
  completeAndRetrigger,
  RETRIGGER_CAP,
} from "../src/lib/retrigger";
import { FakeD1 } from "./helpers/d1";

function makeEnv() {
  return {
    DB: new FakeD1() as never,
    OPERATOR_TOKEN: "op-token",
    SERVER_SECRET: "server-secret-for-tests",
    ENCRYPTION_KEY: "e".padEnd(64, "0"),
  };
}

async function seedSubmission(
  db: FakeD1,
  id: string,
  topics: string[],
  parent: string | null = null,
) {
  await db
    .prepare(
      "INSERT INTO submissions (id, code_hmac, status, kind, parent_id, round, created_at) VALUES (?, ?, 'open', 'original', ?, 0, ?)",
    )
    .bind(id, `hmac-${id}`, parent, new Date().toISOString())
    .run();
  for (const t of topics) {
    await db
      .prepare(
        "INSERT INTO topics (submission_id, topic, source) VALUES (?, ?, 'baseline')",
      )
      .bind(id, t)
      .run();
  }
}

async function seedDoc(db: FakeD1, kit: VaultKit, id: string, text: string) {
  await db
    .prepare(
      "INSERT INTO corpus_docs (id, filename, lane, status, verdict, text_envelope, raw_key, reason, created_at) VALUES (?, ?, 'native', 'parsed', 'clean', ?, NULL, NULL, ?)",
    )
    .bind(
      id,
      await sealText(kit, `${id}.txt`),
      await sealText(kit, text),
      new Date().toISOString(),
    )
    .run();
}

async function angleCount(db: FakeD1): Promise<number> {
  const rows = (await db
    .prepare("SELECT id FROM angles")
    .all()) as Array<{ id: string }>;
  return rows.length;
}

describe("automatic retrigger (R4)", () => {
  it("queues a grounded angle for genuinely new ground", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedSubmission(db, "s1", ["pay"]);
    await seedDoc(db, kit, "d1", "Penalty rates and pay bands are contentious.");

    const r = await retriggerOnCompletion(db as never, kit, env as never, "s1");
    expect(r.new_topics).toEqual(["pay"]);
    expect(r.angles_queued).toBeGreaterThan(0);
    expect(await angleCount(db)).toBeGreaterThan(0);
  });

  it("does not retrigger on corroboration-only material", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    // Another submission already settled "pay".
    await seedSubmission(db, "s2", ["pay"]);
    await seedSubmission(db, "s1", ["pay"]);
    await seedDoc(db, kit, "d1", "Penalty rates and pay bands.");

    const r = await retriggerOnCompletion(db as never, kit, env as never, "s1");
    expect(r.new_topics).toEqual([]);
    expect(r.angles_queued).toBe(0);
    expect(await angleCount(db)).toBe(0);
  });

  it("never rebills settled ground on a repeat", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedSubmission(db, "s1", ["pay"]);
    await seedDoc(db, kit, "d1", "Penalty rates and pay bands.");

    await retriggerOnCompletion(db as never, kit, env as never, "s1");
    const after1 = await angleCount(db);
    const r2 = await retriggerOnCompletion(db as never, kit, env as never, "s1");
    expect(r2.new_topics).toEqual([]);
    expect(await angleCount(db)).toBe(after1);
  });

  it("completes once and skips re-billing on later calls", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    await seedSubmission(db, "s1", ["pay"]);
    await seedDoc(db, kit, "d1", "Penalty rates and pay bands.");

    const first = await completeAndRetrigger(db as never, kit, env as never, "s1");
    expect(first.new_topics).toEqual(["pay"]);
    const second = await completeAndRetrigger(db as never, kit, env as never, "s1");
    expect(second.tier).toBe("already-complete");
    const status = (await db
      .prepare("SELECT status FROM submissions WHERE id = ?")
      .bind("s1")
      .first()) as { status: string };
    expect(status.status).toBe("complete");
  });

  it("caps new topics per event", async () => {
    const env = makeEnv();
    const { kit } = await boot(env as never);
    const db = env.DB as FakeD1;
    const topics = ["roster", "safety", "pay", "hours", "culture", "union", "training"];
    await seedSubmission(db, "s1", topics);
    await seedDoc(
      db,
      kit,
      "d1",
      "Roster safety pay hours culture union training all appear here.",
    );

    const r = await retriggerOnCompletion(db as never, kit, env as never, "s1");
    expect(r.new_topics.length).toBeLessThanOrEqual(RETRIGGER_CAP);
  });
});
