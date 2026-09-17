// Breach assessment domain (Privacy Act 1988 (Cth) Part IIIC): the facts and
// the decision are sealed at rest; the awareness date and decision outcome
// stay plaintext so the thirty-day assessment clock (s 26WH) is visible
// without opening the record. The statement builder drafts the document the
// Commissioner and at-risk individuals must receive (ss 26WK–26WL) — a
// draft for the operator and their legal adviser, never an automatic filing.

import { z } from "zod";

/** s 26WH: reasonable and expeditious assessment, all reasonable steps
 *  within 30 days of becoming aware of the suspected breach. */
export const NDB_ASSESSMENT_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export const BreachFactsSchema = z.object({
  /** The organisation's identity and contact details (statement leg (a)). */
  operator_name: z.string().min(1).max(200),
  operator_contact: z.string().min(1).max(500),
  description: z.string().min(1).max(4000),
  kinds_of_information: z.array(z.string().min(1).max(200)).min(1).max(32),
  individuals_affected: z.number().int().min(0).max(1_000_000_000),
  /** Likelihood of serious harm: the s 26WE threshold question. */
  harm_assessment: z.string().min(1).max(4000),
  containment_steps: z.string().max(4000).default(""),
  /** Recommended steps for affected individuals (statement leg (d)). */
  recommended_steps: z.string().max(4000).default(""),
});
export type BreachFacts = z.infer<typeof BreachFactsSchema>;

export const BreachOutcomeSchema = z.enum([
  "pending",
  "eligible",
  "not_eligible",
]);
export type BreachOutcome = z.infer<typeof BreachOutcomeSchema>;

/** What is sealed into the record envelope. */
export const BreachRecordSchema = z.object({
  facts: BreachFactsSchema,
  outcome: BreachOutcomeSchema.default("pending"),
  reasoning: z.string().max(4000).default(""),
});
export type BreachRecord = z.infer<typeof BreachRecordSchema>;

export interface BreachClock {
  aware_at: string;
  deadline_at: string;
  /** Whole days left in the window; 0 once the deadline has passed. */
  days_remaining: number;
  overdue: boolean;
  days_overdue: number;
}

/** The visible thirty-day clock for one assessment. */
export function breachClock(awareAt: string, nowIso: string): BreachClock {
  const aware = Date.parse(awareAt);
  const now = Date.parse(nowIso);
  if (Number.isNaN(aware) || Number.isNaN(now)) {
    throw new Error("breach clock needs valid ISO timestamps");
  }
  const deadline = aware + NDB_ASSESSMENT_WINDOW_DAYS * DAY_MS;
  const deadlineAt = new Date(deadline).toISOString();
  if (now >= deadline) {
    return {
      aware_at: awareAt,
      deadline_at: deadlineAt,
      days_remaining: 0,
      overdue: true,
      days_overdue: Math.floor((now - deadline) / DAY_MS),
    };
  }
  return {
    aware_at: awareAt,
    deadline_at: deadlineAt,
    days_remaining: Math.ceil((deadline - now) / DAY_MS),
    overdue: false,
    days_overdue: 0,
  };
}

function decisionLine(record: BreachRecord): string {
  switch (record.outcome) {
    case "eligible":
      return (
        "Assessed as an eligible data breach: the Commissioner and the " +
        "individuals at risk of serious harm must be notified as soon as " +
        "practicable (Privacy Act 1988 (Cth) ss 26WK–26WL)."
      );
    case "not_eligible":
      return (
        "Assessed as not an eligible data breach: no notification is " +
        "required, but the assessment should be revisited if new facts emerge."
      );
    default:
      return (
        "Assessment in progress: the decision is pending and must be made " +
        "within the statutory window (s 26WH)."
      );
  }
}

/**
 * Draft the statement required by s 26WK of the Privacy Act: the
 * organisation's identity and contact details, a description of the breach,
 * the kinds of information concerned, and the recommended steps for
 * individuals. The output is a draft for the operator and their legal
 * adviser — Surveyor does not give legal advice and does not file.
 */
export function oaicStatement(
  record: BreachRecord,
  clock: BreachClock,
  nowIso: string,
): string {
  const f = record.facts;
  const lines: string[] = [
    "# Notifiable data breach — draft statement",
    "",
    `Prepared: ${nowIso.slice(0, 10)}`,
    "",
    "> Draft for the operator and their legal adviser. This is not legal",
    "> advice. Review it (and any correction of facts) before it is given to",
    "> the Commissioner or to any affected individual.",
    "",
    "## Decision",
    decisionLine(record),
  ];
  if (record.reasoning) {
    lines.push("", `Reasoning: ${record.reasoning}`);
  }
  lines.push(
    "",
    "## 1. Organisation and contact",
    "",
    f.operator_name,
    "",
    f.operator_contact,
    "",
    "## 2. Description of the breach",
    "",
    f.description,
    "",
    "## 3. Kinds of information concerned",
    "",
    ...f.kinds_of_information.map((k) => `- ${k}`),
    "",
    "## 4. Individuals affected",
    "",
    `${f.individuals_affected} individual(s) at risk of serious harm, or the operator's current estimate of that number.`,
    "",
    "## 5. Likely serious harm",
    "",
    f.harm_assessment,
    "",
    "## 6. Steps taken to contain the breach",
    "",
    f.containment_steps || "None recorded yet.",
    "",
    "## 7. Recommended steps for individuals",
    "",
    f.recommended_steps || "None recorded yet — complete before notifying.",
    "",
    "## 8. Assessment clock (s 26WH)",
    "",
    `Aware of the suspected breach: ${clock.aware_at.slice(0, 10)}`,
    "",
    `Assessment deadline (30 days): ${clock.deadline_at.slice(0, 10)}`,
    "",
    clock.overdue
      ? clock.days_overdue > 0
        ? `Overdue by ${clock.days_overdue} day(s) — assess and notify as soon as practicable.`
        : "Overdue — assess and notify as soon as practicable."
      : `${clock.days_remaining} day(s) remaining to complete the assessment.`,
    "",
    "## 9. Notification channels",
    "",
    "- Office of the Australian Information Commissioner (OAIC) — notification form for eligible data breaches.",
    "- Each individual at risk of serious harm — by whatever channel the operator has; this installation holds no contact details.",
    "",
    "---",
    "Generated by Surveyor from this installation's breach assessment record.",
  );
  return lines.join("\n");
}
