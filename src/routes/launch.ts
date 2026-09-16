// Launch pack routes: operator-gated generation and rotation, public
// slug landing. The pack is public-safe by construction (bare URL, no
// tracking vectors, anonymity-first copy); generation still requires the
// operator because the slug is installation identity.

import { Hono } from "hono";
import { z } from "zod";
import QRCode from "qrcode";
import type { Bindings } from "../env";
import { getState } from "../state";
import { auditPack, buildCopy, mintSlug, type LaunchPack } from "../lib/pack";

export const launch = new Hono<{ Bindings: Bindings }>();

const SlugSchema = z.string().min(1).max(64);
const ForbiddenSchema = z.array(z.string().min(1).max(128)).max(32);

async function currentSlug(db: D1Database): Promise<string> {
  const row = await db
    .prepare("SELECT slug FROM launch WHERE id = 1")
    .first<{ slug: string }>();
  if (row) return row.slug;
  const slug = mintSlug();
  await db.batch([
    db
      .prepare("INSERT INTO launch (id, slug, rotated_at) VALUES (1, ?, ?)")
      .bind(slug, new Date().toISOString()),
  ]);
  return slug;
}

function originOf(c: { req: { url: string }; env: Bindings }): string {
  // Configured public base wins; the request origin is only a fallback
  // (Host headers are caller-controlled, never installation identity).
  const configured = (c.env as unknown as Record<string, unknown>)
    .PUBLIC_BASE_URL;
  if (typeof configured === "string" && configured.length > 0) {
    return configured.replace(/\/+$/, "");
  }
  return new URL(c.req.url).origin;
}

/** Portrait story asset: square QR centred on a 9:16 canvas with caption.
 *  The code stays square (scannability); the canvas is the story shape. */
function storySvg(qrSvg: string, caption: string): string {
  const inner = qrSvg
    .replace(/^[\s\S]*?<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  const safe = caption
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640">` +
    `<rect width="360" height="640" fill="#ffffff"/>` +
    `<g transform="translate(0,40)">${inner}</g>` +
    `<text x="180" y="480" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#1a1a1a">Anonymous survey</text>` +
    `<text x="180" y="510" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#555555">No accounts, no tracking</text>` +
    `<text x="180" y="560" text-anchor="middle" font-family="sans-serif" font-size="11" fill="#555555">${safe}</text>` +
    `</svg>`
  );
}

async function buildQrPair(url: string): Promise<{
  square: string;
  story: string;
}> {
  const square = await QRCode.toString(url, {
    type: "svg",
    width: 360,
    margin: 2,
  });
  return { square, story: storySvg(square, url) };
}

async function buildPack(origin: string, slug: string): Promise<LaunchPack> {
  const url = `${origin}/s/${slug}`;
  const { square, story } = await buildQrPair(url);
  return {
    submissions_url: url,
    qr_square_svg: square,
    qr_story_svg: story,
    ...buildCopy(url),
  };
}

/** Build + audit + serialise, shared by generate and rotate. */
async function issuePack(
  c: { req: { url: string }; env: Bindings },
  slug: string,
  forbidden: string[],
): Promise<Response> {
  const pack = await buildPack(originOf(c), slug);
  const audit = auditPack(pack, forbidden);
  if (!audit.ok) {
    // Structural self-check: our own builder must always pass.
    return Response.json(
      { error: "pack_failed_audit", detail: audit.error },
      { status: 500 },
    );
  }
  return Response.json(pack);
}

function forbiddenFrom(c: {
  req: { query(key: string): string | string[] | undefined };
}): string[] | Response {
  const raw = c.req.query("forbidden") ?? [];
  const parsed = ForbiddenSchema.safeParse(
    Array.isArray(raw) ? raw : [raw],
  );
  if (!parsed.success) {
    return Response.json({ error: "invalid_terms" }, { status: 422 });
  }
  return parsed.data;
}

launch.get("/", async (c) => {
  await getState(c.env); // boot migration side effect
  const terms = forbiddenFrom(c);
  if (terms instanceof Response) return terms;
  const slug = await currentSlug(c.env.DB);
  return issuePack(c, slug, terms);
});

launch.post("/rotate", async (c) => {
  await getState(c.env); // boot migration side effect
  const terms = forbiddenFrom(c);
  if (terms instanceof Response) return terms;
  const slug = mintSlug();
  const now = new Date().toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO launch (id, slug, rotated_at) VALUES (1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET slug = excluded.slug, rotated_at = excluded.rotated_at",
    ).bind(slug, now),
  ]);
  return issuePack(c, slug, terms);
});

export default launch;
