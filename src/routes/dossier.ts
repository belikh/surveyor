// Case dossier routes: one investigation's working file — angles, lines and
// findings, report versions, and the operator's sealed notes. Operator-only
// throughout: findings and notes never render on a public surface.

import { Hono } from "hono";
import type { Bindings } from "../env";
import { getState } from "../state";
import {
  DossierNoteSchema,
  addDossierNote,
  gatherDossier,
  renderDossier,
} from "../lib/dossier";

export const dossier = new Hono<{ Bindings: Bindings }>();

dossier.get("/", async (c) => {
  const app = await getState(c.env);
  return c.json(await gatherDossier(c.env.DB, app.kit));
});

// One exportable file: a Markdown attachment with resolving internal links.
dossier.get("/export", async (c) => {
  const app = await getState(c.env);
  const markdown = renderDossier(await gatherDossier(c.env.DB, app.kit));
  return c.body(markdown, 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": 'attachment; filename="case-dossier.md"',
  });
});

dossier.post("/notes", async (c) => {
  const app = await getState(c.env);
  const parsed = DossierNoteSchema.safeParse(
    await c.req.json().catch(() => ({})),
  );
  if (!parsed.success) return c.json({ error: "invalid_body" }, 422);
  return c.json(await addDossierNote(c.env.DB, app.kit, parsed.data.note), 201);
});

export default dossier;
