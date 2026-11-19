// Writes a chapter's question bank with Claude, in two passes:
//   1. write: concepts and questions from the chapter text, following prompts/question-writing.md
//   2. verify: check every item against the text and return a corrected bank
// then mechanical checks (shape, verbatim passages) before it's loaded.
// Runs in the background; chapter status lives in the database so a restart resumes the queue.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadBank, tx } from "./db.js";

const MODEL = "claude-opus-5-5";
const CONCURRENCY = 3;

const BRIEF = readFileSync(join(import.meta.dirname, "..", "prompts", "question-writing.md"), "utf8");

const QUESTION = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["recall", "comprehension", "application"] },
    reasoning: { type: "boolean" },
    prompt: { type: "string" },
    answer: { type: "string" },
    why: { type: "string" },
    distractors: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, why: { type: "string" } },
        required: ["text", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["level", "reasoning", "prompt", "answer", "why", "distractors"],
  additionalProperties: false,
};

const BANK_SCHEMA = {
  type: "object",
  properties: {
    notes: { type: "string" },
    concepts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slug: { type: "string" },
          importance: { type: "integer", enum: [1, 2, 3] },
          statement: { type: "string" },
          passage: { type: "string" },
          questions: { type: "array", items: QUESTION },
        },
        required: ["slug", "importance", "statement", "passage", "questions"],
        additionalProperties: false,
      },
    },
  },
  required: ["notes", "concepts"],
  additionalProperties: false,
};

const WRITE_INSTRUCTIONS = `You write question banks for Personal University, a quiz app one person uses to retain what they read. They have just read the chapter below and will be quizzed on it over the coming months, a few questions at a time on their phone.

First identify the chapter's concepts: the ideas, mechanisms, arguments and key facts worth remembering months from now. Roughly one concept per 250 words of substantive text, at most 40. Skip trivia, anecdote color and attributions unless they carry the argument. For each concept:
- slug: short kebab-case id, unique in the chapter.
- importance: 3 = core idea of the chapter, 2 = supporting idea, 1 = detail worth knowing.
- statement: the idea in 1 to 3 sentences, self-contained.
- passage: one sentence or clause copied EXACTLY, character for character, from the chapter text, that supports the statement. It is shown to the learner as "From the book" and checked mechanically; a paraphrase will be rejected.
- questions: 1 to 3 multiple-choice questions testing the concept, mixing recall, comprehension and application. Most concepts need one or two.

Set "notes" to an empty string.

Follow this brief exactly:

${BRIEF}`;

const VERIFY_INSTRUCTIONS = `You are checking a draft question bank for Personal University against the chapter it was written from. The learner will trust these questions, so a wrong answer key or a defensible distractor does real damage.

Check every concept and question against the chapter text:
- The correct answer must be clearly correct according to the text.
- Each distractor must be unambiguously wrong, and its "why" must be accurate. Watch especially for distractors that are arguably true.
- Distractors must come from the material (true of something else in the chapter, or a plausible misreading), never invented reasons.
- "passage" must be an exact quote from the chapter. Replace it with an exact quote if it isn't.
- Statements and explanations must not add facts the chapter doesn't support. Application questions marked "reasoning": true may go beyond the text, but their premises must not contradict it.
- The correct answer must not stand out by length or by being the only hedged, qualified option.

Fix what you can. Drop a question you can't make sound, and drop a concept if no question survives. Keep everything that is already good unchanged. Return the full corrected bank, and in "notes" summarize briefly what you changed and why.

The brief the bank was written to:

${BRIEF}`;

let client;
const getClient = () => (client ??= new Anthropic());

async function callClaude(system, user) {
  const stream = getClient().beta.messages.stream({
    model: MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: BANK_SCHEMA } },
    system,
    messages: [{ role: "user", content: user }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("The request was declined");
  if (message.stop_reason === "max_tokens") throw new Error("The bank was too long to finish");
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

const squash = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

// Mechanical checks the model can't be trusted with. Returns a bank in the shape loadBank expects.
export function cleanBank(raw, chapterText) {
  const haystack = squash(chapterText);
  const used = new Set();
  const dropped = [];
  const concepts = [];
  for (const c of raw.concepts) {
    let slug = c.slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "concept";
    while (used.has(slug)) slug += "-x";
    if (!c.passage || !haystack.includes(squash(c.passage))) {
      dropped.push(`${slug}: passage not found in the text`);
      continue;
    }
    const questions = c.questions.filter((q) => {
      const options = [q.answer, ...q.distractors.map((d) => d.text)];
      const ok = q.distractors.length === 3 && new Set(options.map(squash)).size === 4 && q.prompt && q.why;
      if (!ok) dropped.push(`${slug}: malformed question "${q.prompt?.slice(0, 60)}"`);
      return ok;
    });
    if (!questions.length) continue;
    used.add(slug);
    concepts.push({
      id: slug,
      importance: c.importance,
      statement: c.statement,
      passage: c.passage,
      questions: questions.map((q, i) => ({ ...q, id: `${slug}/${i + 1}` })),
    });
  }
  return { concepts, dropped };
}

export async function generateBank(book, chapterTitle, text, call = callClaude) {
  const material = `Book: ${book}\nChapter: ${chapterTitle}\n\n<chapter>\n${text}\n</chapter>`;
  const draft = await call(WRITE_INSTRUCTIONS, `${material}\n\nWrite the question bank for this chapter.`);
  const verified = await call(
    VERIFY_INSTRUCTIONS,
    `${material}\n\n<draft_bank>\n${JSON.stringify({ concepts: draft.concepts })}\n</draft_bank>\n\nCheck and correct the draft.`,
  );
  const { concepts, dropped } = cleanBank(verified, text);
  return { concepts, notes: verified.notes, dropped };
}

// --- Background queue ---

let running = 0;
let dbRef;
let callRef;

export function startQueue(db, call) {
  dbRef = db;
  callRef = call;
  // Work interrupted by a restart goes back in the queue.
  db.prepare("UPDATE chapters SET gen_status = 'queued' WHERE gen_status = 'running'").run();
  pump();
}

export function pump() {
  if (!dbRef || !(callRef || process.env.ANTHROPIC_API_KEY)) return;
  while (running < CONCURRENCY) {
    const next = dbRef.prepare("SELECT id FROM chapters WHERE gen_status = 'queued' ORDER BY source_id, number LIMIT 1").get();
    if (!next) return;
    dbRef.prepare("UPDATE chapters SET gen_status = 'running', gen_error = NULL WHERE id = ?").run(next.id);
    running++;
    runOne(next.id).finally(() => {
      running--;
      pump();
    });
  }
}

async function runOne(chapterId) {
  const db = dbRef;
  const ch = db.prepare(
    "SELECT ch.title, ch.text, s.title AS book FROM chapters ch JOIN sources s ON s.id = ch.source_id WHERE ch.id = ?",
  ).get(chapterId);
  const started = Date.now();
  try {
    const { concepts, notes, dropped } = await generateBank(ch.book, ch.title, ch.text, callRef ?? callClaude);
    if (concepts.length < 3) throw new Error(`Only ${concepts.length} usable concepts came back`);
    tx(db, () => {
      loadBank(db, chapterId, { concepts });
      db.prepare("UPDATE chapters SET has_bank = 1, gen_status = 'ready', gen_error = NULL WHERE id = ?").run(chapterId);
    });
    const n = concepts.reduce((sum, c) => sum + c.questions.length, 0);
    console.log(`Generated ${chapterId}: ${concepts.length} concepts, ${n} questions in ${Math.round((Date.now() - started) / 1000)}s`);
    if (notes) console.log(`  verifier: ${notes}`);
    for (const d of dropped) console.log(`  dropped ${d}`);
  } catch (err) {
    console.error(`Generation failed for ${chapterId}`, err);
    db.prepare("UPDATE chapters SET gen_status = 'failed', gen_error = ? WHERE id = ?").run(String(err.message ?? err).slice(0, 300), chapterId);
  }
}
