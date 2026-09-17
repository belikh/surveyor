// Residency and data-flow routes (D6, #49). The map is computed live from
// the installation's configured services and providers, so it moves when
// configuration changes; a recorded receipt is an append-only snapshot an
// operator can export for the APP 8 record. Operator-gated: the map names
// provider labels, models and capability tags.

import { Hono } from "hono";
import type { Bindings } from "../env";
import { getState } from "../state";
import {
  collectEnvDataFlowMap,
  dataFlowReceiptAt,
  listDataFlowReceipts,
  recordDataFlowReceipt,
  renderDataFlowReceipt,
} from "../lib/residency";

export const residency = new Hono<{ Bindings: Bindings }>();

residency.get("/", async (c) => {
  const st = await getState(c.env); // boot migration side effect
  const setup = await st.loadSetup();
  return c.json(collectEnvDataFlowMap(c.env, setup));
});

residency.post("/receipts", async (c) => {
  const st = await getState(c.env);
  const setup = await st.loadSetup();
  const receipt = await recordDataFlowReceipt(
    c.env.DB,
    collectEnvDataFlowMap(c.env, setup),
  );
  await st.audit(`residency:receipt-recorded ${receipt.id}`);
  return c.json({ receipt }, 201);
});

residency.get("/receipts", async (c) => {
  await getState(c.env); // boot migration side effect
  return c.json({ receipts: await listDataFlowReceipts(c.env.DB) });
});

residency.get("/receipts/:id/export", async (c) => {
  await getState(c.env); // boot migration side effect
  const receipt = await dataFlowReceiptAt(c.env.DB, c.req.param("id"));
  if (!receipt) return c.json({ error: "not_found" }, 404);
  return c.body(renderDataFlowReceipt(receipt.map), 200, {
    "content-type": "text/markdown; charset=utf-8",
    "content-disposition": `attachment; filename="data-flow-receipt-${receipt.id}.md"`,
  });
});

export default residency;
