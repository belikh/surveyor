// Anonymous intake domain: validation schemas, static fallback rounds,
// deterministic quarantine extraction. Raw submitter text is scrubbed and
// sealed before storage — never persisted (constitution I).

import { z } from "zod";
import { ConsentBodySchema, SensitiveCategorySchema } from "./consent";

export const PowProofSchema = z.object({
  challenge: z.string().min(1).max(512),
  nonce: z.string().min(1).max(32),
});

export const CreateBodySchema = z.object({
  pow: PowProofSchema,
  turnstile_token: z.string().max(2048).optional(),
  /** Granular sensitive-category consent given before any answer is stored. */
  consent: ConsentBodySchema.optional(),
});

export const AnswerSchema = z.object({
  q: z.string().min(1).max(128),
  value: z.string().max(10_000),
  topic: z.string().min(1).max(64),
  /** Sensitive categories this answer contains, as declared by the source. */
  sensitive_categories: z.array(SensitiveCategorySchema).max(9).optional(),
});

/** The source's identity: the access code minted at creation (XXXX-XXXX). */
export const AccessCodeSchema = z.string().min(9).max(9);

export const StepsBodySchema = z.object({
  answers: z.array(AnswerSchema).min(1).max(32),
  access_code: AccessCodeSchema,
});

export const RoundsBodySchema = z.object({
  access_code: AccessCodeSchema,
});

export const ResumeBodySchema = z.object({
  access_code: AccessCodeSchema,
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

// Name-word shapes by Unicode category, so full-width and non-Latin
// look-alikes are seen too, not just ASCII title case.
const NAME_WORD =
  "\\p{Lu}\\p{Ll}*(?:['’\\-]\\p{L}+)+|\\p{Lu}\\p{Ll}+|\\p{Lu}{2,}";
// Runs of name-shaped words are claimed together so "Sandra Bell" is one
// identity, not two.
const NAME_RUN = new RegExp(
  `\\b(?:${NAME_WORD})(?:\\s+(?:${NAME_WORD}))+\\b`,
  "gu",
);
// Any standalone capitalised token is a name candidate. Enumerating the
// words a name may follow only hides the ones the list happens not to have,
// so unknown tokens fail closed: false positives cost a label, false
// negatives cost a source.
const NAME_TOKEN = new RegExp(`\\b(?:${NAME_WORD})\\b`, "gu");

// Unicode format characters: invisible by definition, so they can split a
// name or marker token past any pattern. Removed before matching.
const FORMAT_CHARS = /\p{Cf}/gu;

/**
 * Canonical text form for gating and storage: NFC for the reader, format
 * characters removed so what is scanned is what is stored and what a human
 * sees.
 */
export function canonicaliseText(raw: string): string {
  return raw.normalize("NFC").replace(FORMAT_CHARS, "");
}

// Ordinary sentence vocabulary that must survive the gate: a non-name
// allow-list, not a context gate. No static list of sentence openers is
// complete, which is why the default for unknown tokens is to label.
const NOT_NAMES = new Set(
  (
    "Monday,Tuesday,Wednesday,Thursday,Friday,Saturday,Sunday," +
    "Mondays,Tuesdays,Wednesdays,Thursdays,Fridays,Saturdays,Sundays," +
    "January,February,March,April,May,June,July,August,September,October,November,December," +
    "the,this,that,these,those,they,their,them,then,than,there,what,when,where,which,who,whom,why,how," +
    "my,our,your,his,her,its,we,you,he,she,it,us,me,him,anyone,someone,everyone,nobody," +
    "but,and,or,if,so,as,at,by,for,from,in,into,of,on,onto,to,with,without," +
    "also,however,therefore,because,since,until,while,during,after,before,between,above,below,under,over," +
    "again,still,now,just,only,even,not,no,yes,all,any,some,each,every,other,others,most,many,few,both," +
    "either,neither,such,same,very,too,well,sure,okay,ok," +
    "is,are,was,were,be,been,being,has,have,had,do,does,did,can,could,will,would,shall,should,may,might,must," +
    "get,got,go,goes,went,come,comes,came,say,says,said,tell,told,ask,asked,call,called,name,named,meet,met," +
    "work,works,worked,make,makes,made,take,takes,took,give,gives,gave,see,saw,seen,know,knew,think,thought," +
    "want,wanted,need,needed,use,used,find,found,keep,kept,let,put,set,run,ran,move,moved,turn,turned," +
    "show,showed,start,started,stop,stopped,change,changed,report,reported,record,recorded,submit,submitted," +
    "upload,uploaded,download,downloaded," +
    "rosters,roster,hours,hour,pay,overtime,penalties,penalty,allowance,allowances,night,nights,shift,shifts," +
    "day,days,week,weeks,month,months,year,years,time,times,morning,afternoon,evening,today,tomorrow,yesterday," +
    "safety,management,manager,supervisors,supervisor,training,equipment,breaks,break,union,injury,injuries," +
    "culture,staff,workers,worker,crew,crews,team,teams,site,company,workplace,job,jobs,survey,surveys," +
    "report,reports,question,questions,answer,answers,submission,submissions,note,notes,field,evidence," +
    "source,sources,interview,interviews,investigation,data,privacy,consent,meeting,meetings,memo,minutes," +
    "document,documents,draft,version,records,record,policy,procedure,procedures,process,system,systems," +
    "issue,issues,incident,incidents,claim,claims,finding,findings,exhibit,exhibits,entry,entries,log,logs," +
    "email,emails,phone,message,messages,form,forms,list,lists," +
    "transcribed,extracted,registry,detected,recognised,scanned," +
    "pdf,ocr,csv,tsv,url,urls,api,whs,hr,it,ppe,sop,kpi,eba,abn,tfn,nsw,qld,vic,tas,sa,wa,act,nt,am,pm," +
    "ceo,cfo,coo,md,gm,gp,rn,en,een,ain,hse,ohs,fifo,dido,eap,rdo,ado,toil,gis,qa,qc,id,ids," +
    "australia,australian,sydney,melbourne,brisbane,perth,adelaide,canberra,darwin,hobart," +
    "the,this,that,they,there,what,when,my,our"
  )
    .split(",")
    .map((w) => w.toLowerCase()),
);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface QuarantineHit {
  label: string;
  name: string;
}

/**
 * Deterministic quarantine extraction: every capitalised token outside the
 * non-name set becomes a stable per-submission pseudonym (`[person A]`…);
 * the text is scrubbed. Conservative in intent, fail-closed in practice:
 * false positives cost a label, false negatives cost a source.
 */
export function quarantineText(
  raw: string,
): { scrubbed: string; hits: QuarantineHit[] } {
  // Canonicalise first: a zero-width inside "S\u200bandra" must not hide the
  // name from the patterns, and the scrubbed text is what gets stored.
  const text = canonicaliseText(raw);
  const names = new Map<string, string>();
  const claims: Array<{ raw: string; label: string }> = [];
  const hits: QuarantineHit[] = [];
  const claim = (raw: string): string => {
    if (NOT_NAMES.has(raw.toLowerCase())) return raw;
    let label = names.get(raw.toLowerCase());
    if (!label) {
      label = `[person ${String.fromCharCode(65 + names.size)}]`;
      names.set(raw.toLowerCase(), label);
      claims.push({ raw, label });
      hits.push({ label, name: raw });
    }
    return label;
  };
  let scrubbed = text
    .replace(NAME_RUN, (m) =>
      m
        .split(/\s+/)
        .every((t) => NOT_NAMES.has(t.toLowerCase()))
        ? m
        : claim(m),
    )
    .replace(NAME_TOKEN, (m) => claim(m));
  // Names already seen in this document keep matching case-insensitively,
  // so a later lower-case mention is still scrubbed. Longest first so a
  // token that is part of a claimed full name cannot consume it.
  for (const { raw, label } of [...claims].sort(
    (a, b) => b.raw.length - a.raw.length,
  )) {
    scrubbed = scrubbed.replace(
      new RegExp(`\\b${escapeRegExp(raw)}\\b`, "giu"),
      label,
    );
  }
  return { scrubbed, hits };
}
