// AI response to the learner's spoken or typed reasoning.
//
// Grounding: the model sees every concept in the chapter (statement plus source passage)
// and the authored explanation for each option, and is told to stay within that material.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

let client;
function getClient() {
  client ??= new Anthropic();
  return client;
}

export function feedbackAvailable() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

const INSTRUCTIONS = `You are the tutor inside Personal University, an app one person uses to stay sharp on books they have read. They answer a multiple-choice question, and sometimes explain their thinking out loud (transcribed by phone dictation, so expect transcription errors and run-on sentences; don't comment on them).

The app has already told them whether they were right and shown the authored explanation for the correct answer and for the option they picked. Your job is to respond to their reasoning, the way a sharp tutor would in conversation:

- If the reasoning is sound, say so briefly and add nothing they already showed they know.
- If they reached the right answer through a false belief, correct the belief plainly. This matters most: a right answer with a wrong reason is a gap.
- If they ruled options in or out with claims that are wrong, correct those claims too.
- If they said they were unsure or couldn't place something, give them the specific fact they were missing.
- If they were wrong, explain the gap between what they thought and what the book says. Credit good reasoning that happened to land on the wrong answer.
- If they criticize the question itself (an unfair option, ambiguity), take it seriously: agree if they're right, explain if not.

Ground every factual claim in the chapter material below. If they bring up something the chapter doesn't cover, you may use general knowledge, but say it goes beyond the book. Never invent details about the book.

Write 2 to 5 sentences of plain text, no markdown, no lists, no preamble like "Great question". Address them as "you".

Also rate how well they know this concept, for spaced repetition. Only rate when their answer was correct:
- "easy": instant, confident recall with accurate reasoning.
- "good": correct with sound reasoning.
- "hard": correct but unsure, a guess between options, or reasoning that contains a factual error or a real gap.
When their answer was wrong, set rating to null; the app records it as a miss.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    feedback: { type: "string" },
    rating: { anyOf: [{ type: "string", enum: ["easy", "good", "hard"] }, { type: "null" }] },
  },
  required: ["feedback", "rating"],
  additionalProperties: false,
};

// The chapter material is identical for every question in a chapter, so it sits in the
// cached system prefix; only the per-question message varies.
function chapterMaterial(db, chapterId) {
  const ch = db.prepare(
    "SELECT ch.title, ch.number, s.title AS source FROM chapters ch JOIN sources s ON s.id = ch.source_id WHERE ch.id = ?",
  ).get(chapterId);
  const concepts = db.prepare("SELECT statement, passage FROM concepts WHERE chapter_id = ? ORDER BY ord").all(chapterId);
  const body = concepts.map((c, i) => `${i + 1}. ${c.statement}\n   Source passage: "${c.passage}"`).join("\n\n");
  return `Book: ${ch.source}\nChapter ${ch.number}: ${ch.title}\n\nKey ideas of the chapter:\n\n${body}`;
}

export async function getFeedback(db, attempt) {
  const q = db.prepare(
    `SELECT q.*, c.chapter_id, c.statement FROM questions q JOIN concepts c ON c.id = q.concept_id WHERE q.id = ?`,
  ).get(attempt.question_id);
  const distractors = JSON.parse(q.distractors);
  const options = [`CORRECT: ${q.answer}\n  Why: ${q.why}`, ...distractors.map((d) => `WRONG: ${d.text}\n  Why wrong: ${d.why}`)];

  const message = [
    `Question: ${q.prompt}`,
    `Options, with the authored explanations the learner has already seen for the correct one and the one they picked:\n${options.join("\n")}`,
    `Concept being tested: ${q.statement}`,
    `The learner picked: ${attempt.choice} (${attempt.correct ? "correct" : "wrong"})`,
    `The learner's reasoning:\n"""\n${attempt.reasoning}\n"""`,
  ].join("\n\n");

  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
    system: [
      { type: "text", text: INSTRUCTIONS },
      { type: "text", text: chapterMaterial(db, q.chapter_id), cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: message }],
  });

  if (response.stop_reason === "refusal") throw new Error("Feedback request was declined");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const out = JSON.parse(text);
  return { feedback: out.feedback, rating: attempt.correct ? (out.rating ?? "good") : "again" };
}
