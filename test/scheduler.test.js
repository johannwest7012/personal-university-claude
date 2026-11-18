import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { openDb, syncLibrary } from "../server/db.js";
import { pickNext, rateAttempt, retrievability, target } from "../server/scheduler.js";

const DATA = join(import.meta.dirname, "..", "data");

function freshDb() {
  const db = openDb(":memory:");
  syncLibrary(db, DATA);
  return db;
}

function answer(db, q, kind, at, rating) {
  const { lastInsertRowid } = db.prepare(
    "INSERT INTO attempts (question_id, concept_id, at, kind, correct) VALUES (?, ?, ?, ?, ?)",
  ).run(q.id, q.concept_id, at.toISOString(), kind, rating === "again" ? 0 : 1);
  rateAttempt(db, Number(lastInsertRowid), rating);
}

test("only chapters marked read are quizzed", () => {
  const db = freshDb();
  db.prepare("UPDATE chapters SET read_at = NULL").run();
  assert.equal(pickNext(db), null);
  db.prepare("UPDATE chapters SET read_at = ? WHERE id = 'space-to-grow/ch01'").run(new Date().toISOString());
  assert.ok(pickNext(db).question.id.startsWith("space-to-grow/ch01/"));
});

test("a session doesn't repeat a concept back to back", () => {
  const db = freshDb();
  let now = new Date("2026-12-01T12:00:00Z");
  const concepts = [];
  for (let i = 0; i < 6; i++) {
    const { question, kind } = pickNext(db, now);
    concepts.push(question.concept_id);
    answer(db, question, kind, now, "good");
    now = new Date(now.getTime() + 30_000);
  }
  assert.equal(new Set(concepts).size, concepts.length);
});

test("a missed concept comes back within a couple of days, a known one much later", () => {
  const db = freshDb();
  const start = new Date("2026-12-01T12:00:00Z");
  const a = pickNext(db, start).question;
  answer(db, a, "new", start, "again");
  const b = pickNext(db, start).question;
  answer(db, b, "new", start, "good");

  const card = (id) => db.prepare("SELECT card, importance FROM concepts WHERE id = ?").get(id);
  const dueOn = (id) => {
    for (let d = 1; d < 400; d++) {
      const t = new Date(start.getTime() + d * 86_400_000);
      const c = card(id);
      if (retrievability(c.card, t) < target(c.importance)) return d;
    }
    return Infinity;
  };
  assert.ok(dueOn(a.concept_id) <= 2, `missed concept due after ${dueOn(a.concept_id)} days`);
  assert.ok(dueOn(b.concept_id) > dueOn(a.concept_id));
});

test("reviews rotate through question variants of a concept", () => {
  const db = freshDb();
  const conceptId = "space-to-grow/ch01/shuttle-shortfall";
  db.prepare("UPDATE concepts SET killed_at = 'x' WHERE id != ?").run(conceptId);
  const asked = [];
  let now = new Date("2026-12-01T12:00:00Z");
  for (let i = 0; i < 3; i++) {
    const { question, kind } = pickNext(db, now);
    asked.push(question.id);
    answer(db, question, kind, now, "good");
    now = new Date(now.getTime() + 40 * 86_400_000);
  }
  assert.equal(new Set(asked).size, 3);
});

test("killed concepts and flagged questions are never served", () => {
  const db = freshDb();
  db.prepare("UPDATE concepts SET killed_at = 'x' WHERE id != 'space-to-grow/ch01/reusability-2015'").run();
  db.prepare("UPDATE questions SET flagged_at = 'x' WHERE id = 'space-to-grow/ch01/reusability-2015/1'").run();
  for (let i = 0; i < 5; i++) assert.equal(pickNext(db).question.id, "space-to-grow/ch01/reusability-2015/2");
  db.prepare("UPDATE questions SET flagged_at = 'x'").run();
  assert.equal(pickNext(db), null);
});
