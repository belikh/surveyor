// Retention configuration routes (D1, #44): read the effective per-category
// windows with the catalogue of what can and cannot be swept, and update
// them. Operator-gated: a window decides when evidence-bearing bytes are
// deleted. Refusals name the category and the reason; a refused update
// changes nothing.

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../env";
import { getState } from "../state";
import {
  DEFAULT_RETENTION_WINDOWS,
  HOUR_MS,
  RETAINED_CATEGORIES,
  SWEEPABLE_CATEGORIES,
  loadRetentionWindows,
  saveRetentionWindows,
} from "../lib/retention";

export const retention = new Hono<{ Bindings: Bindings }>();

const UpdateSchema = z.object({
  windows: z.unknown(),
});

function hours(ms: number): number {
  return ms / HOUR_MS;
}

async function view(db: D1Database) {
  const windows = await loadRetentionWindows(db);
  return {
    window_unit: "hours",
    windows_ms: windows,
    windows_hours: Object.fromEntries(
      Object.entries(windows).map(([id, ms]) => [id, hours(ms)]),
    ),
    defaults_hours: Object.fromEntries(
      Object.entries(DEFAULT_RETENTION_WINDOWS).map(([id, ms]) => [
        id,
        hours(ms),
      ]),
    ),
    categories: SWEEPABLE_CATEGORIES.map((c) => ({
      ...c,
      min_hours: hours(c.min_ms),
      max_hours: hours(c.max_ms),
    })),
    retained: RETAINED_CATEGORIES,
  };
}

retention.get("/", async (c) => {
  await getState(c.env); // boot migration side effect
  return c.json(await view(c.env.DB));
});

retention.put("/", async (c) => {
  const st = await getState(c.env);
  const parsed = UpdateSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const updated = await saveRetentionWindows(
    c.env.DB,
    parsed.data.windows,
    new Date().toISOString(),
  );
  if (!updated.ok) {
    return c.json(
      { error: "unsupported_retention", refusals: updated.refusals },
      422,
    );
  }
  const named = Object.entries(updated.windows)
    .map(([id, ms]) => `${id}=${hours(ms)}h`)
    .join(" ");
  await st.audit(`retention:configured ${named}`);
  return c.json(await view(c.env.DB));
});

export default retention;
