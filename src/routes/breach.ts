// Breach routes: operator-gated assessment records for Part IIIC of the
// Privacy Act. Facts and decision are sealed; the clock and the decision
// outcome are readable; the statement draft exports as a markdown file.

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { getState } from "../state";
import { openText, sealText, type VaultKit } from "../lib/vault";
import {
  BreachFactsSchema,
  BreachRecordSchema,
  breachClock,
  oaicStatement,
  type BreachClock,
} from "../lib/breach";

export const breach = new Hono<{ Bindings: Bindings }>();

const CreateBodySchema = BreachFactsSchema.extend({
  /** When the operator became aware; defaults to now. */
  aware_at: z.string().datetime().optional(),
});

const DecisionBodySchema = z.object({
  outcome: z.enum(["eligible", "not_eligible"]),
  reasoning: z.string().max(4000).default(""),
});

interface BreachRow {
  id: string;
  aware_at: string;
  decision: string;
  record_envelope: string;
  created_at: string;
  updated_at: string;
}

function publicRow(row: BreachRow, clock: BreachClock) {
  return {
    id: row.id,
    decision: row.decision,
    aware_at: clock.aware_at,
    deadline_at: clock.deadline_at,
    days_remaining: clock.days_remaining,
    overdue: clock.overdue,
    days_overdue: clock.days_overdue,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadRow(db: D1Database, id: string): Promise<BreachRow | null> {
  return db
    .prepare(
      "SELECT id, aware_at, decision, record_envelope, created_at, updated_at " +
        "FROM breach_assessments WHERE id = ?",
    )
    .bind(id)
    .first<BreachRow>();
}

async function openRecord(kit: VaultKit, row: BreachRow) {
  return BreachRecordSchema.parse(
    JSON.parse(await openText(kit, row.record_envelope)),
  );
}

breach.post("/", async (c) => {
  const parsed = CreateBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const st = await getState(c.env);
  const now = new Date().toISOString();
  const awareAt = parsed.data.aware_at ?? now;
  const facts = BreachFactsSchema.parse(parsed.data);
  const record = BreachRecordSchema.parse({
    facts,
    outcome: "pending",
    reasoning: "",
  });
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO breach_assessments " +
      "(id, aware_at, decision, record_envelope, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(id, awareAt, "pending", await sealText(st.kit, JSON.stringify(record)), now, now)
    .run();
  await st.audit("breach:assessment-opened");
  const row: BreachRow = {
    id,
    aware_at: awareAt,
    decision: "pending",
    record_envelope: "",
    created_at: now,
    updated_at: now,
  };
  return c.json(publicRow(row, breachClock(awareAt, now)), 201);
});

breach.get("/", async (c) => {
  await getState(c.env); // boot migration side effect
  const rows = await c.env.DB.prepare(
    "SELECT id, aware_at, decision, record_envelope, created_at, updated_at " +
      "FROM breach_assessments ORDER BY created_at DESC",
  ).all<BreachRow>();
  const list = Array.isArray(rows) ? rows : rows.results;
  const now = new Date().toISOString();
  return c.json({
    assessments: list.map((r) => publicRow(r, breachClock(r.aware_at, now))),
  });
});

breach.get("/:id", async (c) => {
  const st = await getState(c.env);
  const row = await loadRow(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const record = await openRecord(st.kit, row);
  return c.json({
    ...publicRow(row, breachClock(row.aware_at, new Date().toISOString())),
    facts: record.facts,
    reasoning: record.reasoning,
  });
});

breach.post("/:id/decision", async (c) => {
  const parsed = DecisionBodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const st = await getState(c.env);
  const row = await loadRow(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const record = await openRecord(st.kit, row);
  const next = { ...record, ...parsed.data };
  const now = new Date().toISOString();
  await c.env.DB.prepare(
    "UPDATE breach_assessments SET decision = ?, record_envelope = ?, " +
      "updated_at = ? WHERE id = ?",
  )
    .bind(
      next.outcome,
      await sealText(st.kit, JSON.stringify(next)),
      now,
      row.id,
    )
    .run();
  await st.audit("breach:decision-recorded");
  return c.json({
    id: row.id,
    decision: next.outcome,
    ...breachClock(row.aware_at, now),
  });
});

breach.get("/:id/statement", async (c) => {
  const st = await getState(c.env);
  const row = await loadRow(c.env.DB, c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const record = await openRecord(st.kit, row);
  const now = new Date().toISOString();
  const statement = oaicStatement(
    record,
    breachClock(row.aware_at, now),
    now,
  );
  return c.body(statement, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="oaic-statement-${row.id}.md"`,
  });
});

export default breach;
