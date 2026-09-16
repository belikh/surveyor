// Anonymous intake domain: validation schemas, static fallback rounds,
// deterministic quarantine extraction. Raw submitter text is scrubbed and
// sealed before storage — never persisted (constitution I).

import { z } from "zod";

export const PowProofSchema = z.object({
  challenge: z.string().min(1).max(512),
  nonce: z.string().min(1).max(32),
});

export const CreateBodySchema = z.object({
  pow: PowProofSchema,
  turnstile_token: z.string().max(2048).optional(),
});

export const AnswerSchema = z.object({
  q: z.string().min(1).max(128),
  value: z.string().max(10_000),
  topic: z.string().min(1).max(64),
});

export const StepsBodySchema = z.object({
  answers: z.array(AnswerSchema).min(1).max(32),
});

export const ResumeBodySchema = z.object({
  access_code: z.string().min(9).max(9),
});

export const AddendumBodySchema = z.object({
  pow: PowProofSchema,
  access_code: z.string().min(9).max(9),
  turnstile_token: z.string().max(2048).optional(),
});

export interface StaticQuestion {
  topic: string;
  question: string;
}

/** Static fallback pool: full LLM rounds arrive with the engine (T5). */
export const STATIC_QUESTIONS: StaticQuestion[] = [
  { topic: "roster", question: "How are rosters set, and what happens when you push back?" },
  { topic: "safety", question: "Describe a time safety and speed were in conflict." },
  { topic: "pay", question: "How does pay actually work — penalties, overtime, allowances?" },
  { topic: "hours", question: "What do your hours do to sleep, family, and health?" },
  { topic: "management", question: "How does management respond to complaints?" },
  { topic: "bullying", question: "Have you seen bullying or intimidation? What happened?" },
  { topic: "breaks", question: "Do you reliably get your breaks? What interferes?" },
  { topic: "equipment", question: "Is the equipment fit for purpose? What fails?" },
  { topic: "training", question: "Was your training adequate for the real job?" },
  { topic: "union", question: "What role does the union play day to day?" },
  { topic: "injury", question: "Have you been injured, or seen injuries handled badly?" },
  { topic: "culture", question: "What is the one thing outsiders don't understand?" },
];

export const QUESTIONS_PER_ROUND = 3;

/** Next uncovered questions; never re-asks a covered topic. */
export function nextQuestions(
  covered: Set<string>,
  count = QUESTIONS_PER_ROUND,
): StaticQuestion[] {
  return STATIC_QUESTIONS.filter((q) => !covered.has(q.topic)).slice(0, count);
}

const NAME_RUN = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;
// Single-token names in name-bearing contexts: speech-verb objects
// ("told Maddie"), possessives ("Maddie's roster"), vocatives and
// introductions ("called Trent", "named Renee"). Days, months, and common
// sentence-start words are excluded below.
const SINGLE_NAME = /\b(?:told|asked|called|named|with|for|from|by|supervisor|manager)\s+([A-Z][a-z]{2,})\b|\b([A-Z][a-z]{2,})'s\b/g;
const NOT_NAMES = new Set([
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
  "Sunday", "January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December",
  "The", "This", "That", "They", "There", "What", "When", "My", "Our",
]);

export interface QuarantineHit {
  label: string;
  name: string;
}

/**
 * Deterministic quarantine extraction: multi-word capitalised runs become
 * stable per-submission pseudonyms (`[person A]`…); the text is scrubbed.
 * Conservative by design — false positives cost a label, false negatives
 * cost a source.
 */
export function quarantineText(
  text: string,
): { scrubbed: string; hits: QuarantineHit[] } {
  const names = new Map<string, string>();
  const hits: QuarantineHit[] = [];
  const claim = (raw: string): string => {
    if (NOT_NAMES.has(raw)) return raw;
    let label = names.get(raw.toLowerCase());
    if (!label) {
      label = `[person ${String.fromCharCode(65 + names.size)}]`;
      names.set(raw.toLowerCase(), label);
      hits.push({ label, name: raw });
    }
    return label;
  };
  const scrubbed = text
    .replace(NAME_RUN, (m) => claim(m))
    .replace(SINGLE_NAME, (m, a, b) => m.replace(a ?? b, claim(a ?? b)));
  return { scrubbed, hits };
}
