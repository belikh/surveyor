// Notice routes: operator-gated generation and export of the privacy policy
// and collection notice from the installation's actual data flows. Notices
// are public documents, so they are stored unsealed; the data-flow snapshot
// travels with each version.

import { Hono } from "hono";
import type { Bindings } from "../env";
import { getState } from "../state";
import { hasSecretValue } from "../lib/providers";
import {
  NoticeOperatorSchema,
  NoticeTypeSchema,
  collectDataFlows,
  generateNotices,
  latestNotice,
  listNoticeVersions,
  noticeVersionAt,
} from "../lib/notices";

export const notices = new Hono<{ Bindings: Bindings }>();

function typeParam(c: { req: { param(name: string): string } }) {
  const parsed = NoticeTypeSchema.safeParse(c.req.param("type"));
  return parsed.success ? parsed.data : null;
}

notices.post("/generate", async (c) => {
  const parsed = NoticeOperatorSchema.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  const st = await getState(c.env);
  const setup = await st.loadSetup();
  const flows = collectDataFlows({
    setup,
    hasSecret: (slot) => hasSecretValue(c.env, slot),
    workersAi: Boolean(c.env.AI),
    turnstile: Boolean(c.env.TURNSTILE_SECRET),
  });
  const generated = await generateNotices(c.env.DB, parsed.data, flows);
  await st.audit("notices:generated");
  return c.json({ notices: generated, data_flows: flows }, 201);
});

notices.get("/", async (c) => {
  await getState(c.env); // boot migration side effect
  return c.json({ versions: await listNoticeVersions(c.env.DB) });
});

notices.get("/:type", async (c) => {
  const type = typeParam(c);
  if (!type) return c.json({ error: "not_found" }, 404);
  const version = await latestNotice(c.env.DB, type);
  if (!version) return c.json({ error: "not_found" }, 404);
  return c.json(version);
});

notices.get("/:type/versions", async (c) => {
  const type = typeParam(c);
  if (!type) return c.json({ error: "not_found" }, 404);
  const all = await listNoticeVersions(c.env.DB);
  return c.json({ versions: all.filter((v) => v.type === type) });
});

notices.get("/:type/versions/:version/export", async (c) => {
  const type = typeParam(c);
  const version = Number(c.req.param("version"));
  if (!type || !Number.isInteger(version) || version < 1) {
    return c.json({ error: "not_found" }, 404);
  }
  const notice = await noticeVersionAt(c.env.DB, type, version);
  if (!notice) return c.json({ error: "not_found" }, 404);
  return c.body(notice.body, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="${type}-notice-v${version}.md"`,
  });
});

export default notices;
