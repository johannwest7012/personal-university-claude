// Validates a question bank and renders it as markdown for human review.
// Usage: node scripts/render-review.mjs data/space-to-grow/ch01.json > review.md
import { readFileSync } from "node:fs";

const bank = JSON.parse(readFileSync(process.argv[2], "utf8"));
const LEVELS = ["recall", "comprehension", "application"];
const errors = [];
const counts = { recall: 0, comprehension: 0, application: 0 };
const ids = new Set();
let n = 0;
const out = [];

out.push(`# ${bank.source.title}`, `## Chapter ${bank.chapter.number}: ${bank.chapter.title}`, "");

for (const c of bank.concepts) {
  if (ids.has(c.id)) errors.push(`duplicate concept id ${c.id}`);
  ids.add(c.id);
  if (!c.statement || !c.passage || ![1, 2, 3].includes(c.importance)) errors.push(`${c.id}: bad concept fields`);
  out.push(`### ${c.id} (importance ${c.importance})`, "", c.statement, "", `> ${c.passage}`, "");
  for (const q of c.questions) {
    n++;
    if (!LEVELS.includes(q.level)) errors.push(`${c.id}: bad level ${q.level}`);
    else counts[q.level]++;
    if (q.distractors?.length !== 3) errors.push(`${c.id}: needs 3 distractors: ${q.prompt}`);
    if (new Set([q.answer, ...(q.distractors ?? [])]).size !== 4) errors.push(`${c.id}: duplicate options: ${q.prompt}`);
    out.push(`**Q${n}. [${q.level}${q.reasoning ? ", reasoning" : ""}]** ${q.prompt}`, "");
    out.push(`- ✅ ${q.answer}`, ...q.distractors.map((d) => `- ${d}`), "", `_${q.explanation}_`, "");
  }
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.error(`${bank.concepts.length} concepts, ${n} questions`, counts);
console.log(out.join("\n"));
