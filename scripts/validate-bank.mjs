// Validates a chapter question bank (and its attempts file, if present) and prints stats.
// Usage: node scripts/validate-bank.mjs data/space-to-grow/ch01.json
import { existsSync, readFileSync } from "node:fs";

const path = process.argv[2];
const bank = JSON.parse(readFileSync(path, "utf8"));
const LEVELS = new Set(["recall", "comprehension", "application"]);
const errors = [];
const questionIds = new Set();
const conceptIds = new Set();
const levels = { recall: 0, comprehension: 0, application: 0 };
// How many distractors are shorter than the answer: index 0 = answer is shortest, 3 = longest.
// Should be roughly even; a skew in either direction is a guessable tell.
const lengthRank = [0, 0, 0, 0];

for (const c of bank.concepts) {
  if (conceptIds.has(c.id)) errors.push(`duplicate concept ${c.id}`);
  conceptIds.add(c.id);
  if (!c.statement || !c.passage || ![1, 2, 3].includes(c.importance)) errors.push(`${c.id}: missing statement, passage or importance`);
  if (!c.questions?.length) errors.push(`${c.id}: no questions`);

  for (const q of c.questions ?? []) {
    const where = q.id ?? `${c.id}/?`;
    if (!q.id?.startsWith(`${c.id}/`)) errors.push(`${where}: id must start with concept id`);
    if (questionIds.has(q.id)) errors.push(`${where}: duplicate question id`);
    questionIds.add(q.id);
    if (!LEVELS.has(q.level)) errors.push(`${where}: bad level ${q.level}`);
    else levels[q.level]++;
    if (!q.prompt || !q.answer || !q.why) errors.push(`${where}: missing prompt, answer or why`);
    if (q.distractors?.length !== 3) errors.push(`${where}: needs exactly 3 distractors`);
    for (const d of q.distractors ?? []) if (!d.text || !d.why) errors.push(`${where}: distractor missing text or why`);

    const options = [q.answer, ...(q.distractors ?? []).map((d) => d.text)];
    if (new Set(options).size !== options.length) errors.push(`${where}: duplicate options`);
    lengthRank[options.slice(1).filter((o) => o.length < q.answer.length).length]++;
  }
}

const attemptsPath = path.replace(/\.json$/, "-attempts.json");
if (existsSync(attemptsPath)) {
  for (const a of JSON.parse(readFileSync(attemptsPath, "utf8")).attempts) {
    if (!questionIds.has(a.question)) errors.push(`attempt references unknown question ${a.question}`);
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
const n = questionIds.size;
console.log(`${conceptIds.size} concepts, ${n} questions`, levels);
console.log(`answer length position, shortest to longest: ${lengthRank.join(" / ")} (even is about ${Math.round(n / 4)} each)`);
