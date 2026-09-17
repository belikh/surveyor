// C3 email export ingest: EML and mbox parse natively to gated text, with
// headers reduced to what the investigation needs, messages threaded by
// Message-ID/References, and the same pre-mirror gate as every other lane.

import { describe, it, expect } from "vitest";
import { extractEmailText, MAX_EMAIL_MESSAGES } from "../src/lib/email";
import { classifyLane, statusFor } from "../src/lib/ingest";
import { extractNativeText } from "../src/lib/native";
import { buildDrainHandlers, runDrain, type HeldDoc } from "../src/lib/drain";
import { b64 } from "./helpers/docs";

const utf8 = new TextEncoder();

const SINGLE_EML = [
  "Message-ID: <m1@example.com>",
  "Date: Mon, 1 Sep 2026 09:00:00 +1000",
  "From: Zara Kline <zara@example.com>",
  "To: Matt Riley <matt@example.com>",
  "Subject: Roster changes",
  "X-Mailer: SomeMail 1.0",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Rosters are late.",
].join("\r\n");

describe("native email extraction", () => {
  it("extracts an EML message and reduces its headers", () => {
    const text = extractEmailText(utf8.encode(SINGLE_EML));
    expect(text).toContain("# Email thread: Roster changes");
    expect(text).toContain("Date: Mon, 1 Sep 2026 09:00:00 +1000");
    expect(text).toContain("From: Zara Kline <zara@example.com>");
    expect(text).toContain("To: Matt Riley <matt@example.com>");
    expect(text).toContain("Rosters are late.");
    // Raw headers the investigation does not need are dropped.
    expect(text).not.toContain("X-Mailer");
    expect(text).not.toContain("Message-ID:");
  });

  it("decodes MIME-encoded subjects and quoted-printable bodies", () => {
    const raw = [
      "From: a@example.com",
      "Subject: =?utf-8?B?Um9zdGVyIGNoYW5nZXM=?=",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Rosters=20are=20late=2E",
    ].join("\r\n");
    const text = extractEmailText(utf8.encode(raw));
    expect(text).toContain("# Email thread: Roster changes");
    expect(text).toContain("Rosters are late.");
  });

  it("decodes base64 bodies and prefers the plain alternative", () => {
    const plain = Buffer.from("Plain roster body", "utf8").toString("base64");
    const raw = [
      'Content-Type: multipart/alternative; boundary="b"',
      "",
      "--b",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      plain,
      "--b",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Html <b>roster</b> body</p>",
      "--b--",
    ].join("\r\n");
    const text = extractEmailText(utf8.encode(raw));
    expect(text).toContain("Plain roster body");
    expect(text).not.toContain("Html");
  });

  it("falls back to stripped HTML when no plain part exists", () => {
    const raw = [
      "From: a@example.com",
      "Subject: Roster",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Html <b>roster</b> body &amp; notes</p>",
    ].join("\r\n");
    const text = extractEmailText(utf8.encode(raw));
    expect(text).toContain("Html roster body & notes");
    expect(text).not.toContain("<b>");
  });

  it("threads replies with their parents regardless of file order", () => {
    const mbox = [
      "From matt@example.com Mon Sep 1 10:00:00 2026",
      "Message-ID: <m2@example.com>",
      "In-Reply-To: <m1@example.com>",
      "Date: Mon, 1 Sep 2026 10:00:00 +1000",
      "From: Matt Riley <matt@example.com>",
      "To: Zara Kline <zara@example.com>",
      "Subject: Re: Roster changes",
      "",
      "Reply roster body",
      "",
      "From zara@example.com Mon Sep 1 09:00:00 2026",
      "Message-ID: <m1@example.com>",
      "Date: Mon, 1 Sep 2026 09:00:00 +1000",
      "From: Zara Kline <zara@example.com>",
      "To: Matt Riley <matt@example.com>",
      "Subject: Roster changes",
      "",
      "Original roster body",
      "",
      "From sam@example.com Mon Sep 1 11:00:00 2026",
      "Message-ID: <m3@example.com>",
      "Date: Mon, 1 Sep 2026 11:00:00 +1000",
      "From: Sam Doyle <sam@example.com>",
      "To: Matt Riley <matt@example.com>",
      "Subject: Timesheets",
      "",
      "Unrelated timesheet body",
    ].join("\n");
    const text = extractEmailText(utf8.encode(mbox));
    expect(text).toContain("Original roster body");
    expect(text).toContain("Reply roster body");
    // The reply is rendered after its parent even though it arrived first.
    expect(text.indexOf("Original roster body")).toBeLessThan(
      text.indexOf("Reply roster body"),
    );
    // The unrelated message starts a second thread.
    expect(text.match(/# Email thread:/g)?.length).toBe(2);
    expect(text).toContain("# Email thread: Roster changes");
    expect(text).toContain("# Email thread: Timesheets");
  });

  it("truncates an export beyond the message cap", () => {
    const messages = Array.from(
      { length: MAX_EMAIL_MESSAGES + 5 },
      (_, i) =>
        `From a@example.com Mon Sep 1 10:00:00 2026\n` +
        `Message-ID: <m${i}@example.com>\nFrom: A B <a@example.com>\n` +
        `Subject: Note ${i}\n\nbody ${i}`,
    );
    const text = extractEmailText(utf8.encode(messages.join("\n")));
    expect(text).toContain(`[email truncated after ${MAX_EMAIL_MESSAGES} messages]`);
  });

  it("returns no text for bytes that are not email", () => {
    expect(extractEmailText(utf8.encode("this is not an email"))).toBe("");
    expect(extractEmailText(utf8.encode("\u0000\u0001binary"))).toBe("");
  });
});

describe("email lane classification and dispatch", () => {
  it("routes EML and MBOX exports to the held-email lane", () => {
    for (const f of ["export.eml", "inbox.mbox", "mail.mbx"]) {
      const r = classifyLane(f, "application/octet-stream", 100);
      expect(r.lane, f).toBe("held-email");
      expect(r.reason, f).toBeTruthy();
      expect(statusFor(r.lane)).toBe("held");
    }
  });

  it("dispatches held-email to the native tier", async () => {
    const native = await extractNativeText("held-email", utf8.encode(SINGLE_EML));
    expect(native?.tier).toBe("native-email");
    expect(native?.text).toContain("Rosters are late.");
    expect(
      await extractNativeText("held-email", utf8.encode("not email at all")),
    ).toBeNull();
  });
});

const noModel = { ai: undefined, visionClient: null };

function heldEmail(bytes: Uint8Array, id = "e1"): HeldDoc {
  return { id, lane: "held-email", status: "held", bytes_b64: b64(bytes) };
}

describe("email drain", () => {
  it("gates names before the mirror with no model configured", async () => {
    const { results } = await runDrain(
      [heldEmail(utf8.encode(SINGLE_EML))],
      buildDrainHandlers(noModel),
    );
    const r = results[0];
    expect(r.outcome.status).toBe("parsed");
    expect(r.tier).toBe("native-email");
    expect(r.outcome.verdict).toBe("gated");
    expect(r.outcome.text).toContain("Rosters are late.");
    expect(r.outcome.text).not.toContain("Zara Kline");
    expect(r.outcome.text).toContain("[person");
  });

  it("stays held with an actionable reason when nothing can parse it", async () => {
    const { results } = await runDrain(
      [heldEmail(utf8.encode("junk bytes"), "e2")],
      buildDrainHandlers(noModel),
    );
    expect(results[0].outcome.status).toBe("held");
    expect(results[0].outcome.reason).toMatch(/held-email/);
    expect(results[0].outcome.reason).toMatch(/document text extraction/);
  });

  it("never calls the model when native parsing succeeds, and falls back when it fails", async () => {
    let calls = 0;
    const handlers = buildDrainHandlers({
      ai: {
        toMarkdown: async () => {
          calls++;
          return { format: "markdown", data: "model email body" };
        },
      },
      visionClient: null,
    });
    const native = await runDrain([heldEmail(utf8.encode(SINGLE_EML))], handlers);
    expect(calls).toBe(0);
    expect(native.results[0].tier).toBe("native-email");

    const fallback = await runDrain(
      [heldEmail(utf8.encode("junk bytes"), "e2")],
      handlers,
    );
    expect(calls).toBe(1);
    expect(fallback.results[0].tier).toBe("workers-ai-toMarkdown");
    expect(fallback.results[0].outcome.text).toContain("model email body");
  });
});

describe("email lanes at the corpus route", () => {
  async function setup() {
    const { default: app } = await import("../src/index");
    const { FakeD1 } = await import("./helpers/d1");
    const { FakeR2 } = await import("./helpers/r2");
    const db = new FakeD1();
    const corpus = new FakeR2();
    const env = {
      DB: db as never,
      CORPUS: corpus as never,
      OPERATOR_TOKEN: "op-token",
      SERVER_SECRET: "s",
      ENCRYPTION_KEY: "e".padEnd(64, "0"),
    };
    const auth = { authorization: "Bearer op-token" };
    const callApp = (path: string, init?: RequestInit) =>
      app.fetch(new Request(`https://survey.example${path}`, init), env as never);
    const upload = (filename: string, mediaType: string, body: BodyInit) =>
      callApp("/api/corpus", {
        method: "POST",
        headers: {
          ...auth,
          "x-filename": encodeURIComponent(filename),
          "content-type": mediaType,
        },
        body,
      });
    return { db, corpus, callApp, upload, auth };
  }

  it("holds an mbox, drains it natively and gates names before the mirror", async () => {
    const { db, corpus, callApp, upload, auth } = await setup();
    const up = (await (
      await upload("inbox.mbox", "application/mbox", SINGLE_EML)
    ).json()) as Record<string, string>;
    expect(up.lane).toBe("held-email");
    expect(up.status).toBe("held");
    expect(up.verdict).toBe("pending");

    const drained = (await (
      await callApp("/api/corpus/drain", {
        method: "POST",
        headers: auth,
        body: JSON.stringify({}),
      })
    ).json()) as { drained: number };
    expect(drained.drained).toBe(1);

    const list = (await (
      await callApp("/api/corpus", { headers: auth })
    ).json()) as { docs: Array<{ status: string; verdict: string; reason: string | null }> };
    expect(list.docs[0].status).toBe("parsed");
    expect(list.docs[0].verdict).toBe("gated");
    expect(list.docs[0].reason).toBeNull();
    expect(corpus.keys()).toEqual([]);

    const fts = JSON.stringify(await db.prepare("SELECT * FROM corpus_fts").all());
    expect(fts).toContain("Rosters are late.");
    expect(fts).not.toContain("Zara Kline");
    const entities = JSON.stringify(
      await db.prepare("SELECT * FROM entities").all(),
    );
    expect(entities).not.toContain("Zara Kline");
  });
});
