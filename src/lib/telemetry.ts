// Per-turn provider telemetry for the admin audit surface: which tier
// served, how many tool calls. Append-only; values are tier names and
// counts only — never prompts, keys, or content.

import { z } from "zod";

const TurnSchema = z.object({
  tier: z.string().min(1).max(64),
  toolCalls: z.number().int().min(0),
  label: z.string().max(128).optional(),
  outcome: z.string().max(64).optional(),
});

export interface TurnRecord {
  ts: string;
  tier: string;
  toolCalls: number;
  label: string | null;
  outcome: string | null;
}

interface D1 {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      run(): Promise<unknown>;
      all<T>(): Promise<{ results: T[] }>;
    };
  };
}

export async function recordTurn(
  db: D1,
  turn: { tier: string; toolCalls: number; label?: string; outcome?: string },
): Promise<void> {
  const t = TurnSchema.parse(turn);
  await db
    .prepare(
      "INSERT INTO telemetry (ts, tier, tool_calls, label, outcome) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(
      new Date().toISOString(),
      t.tier,
      t.toolCalls,
      t.label ?? null,
      t.outcome ?? null,
    )
    .run();
}

export async function listTelemetry(
  db: D1,
  limit: number,
): Promise<TurnRecord[]> {
  const res = await db
    .prepare(
      "SELECT ts, tier, tool_calls AS toolCalls, label, outcome FROM telemetry " +
        "ORDER BY rowid DESC LIMIT ?",
    )
    .bind(limit)
    .all<TurnRecord>();
  return res.results;
}
