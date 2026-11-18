// Concept-level spaced repetition and question selection.
//
// Memory state (an FSRS card) lives on the concept, not the question, so answering
// one variant counts for the idea and the next review can use a different variant.
// There is no due pile: each request serves the single most useful question right now.
import { createEmptyCard, fsrs, generatorParameters, Rating } from "ts-fsrs";

// No same-day learning steps: sessions are opportunistic, not scheduled study blocks.
const f = fsrs(generatorParameters({ enable_fuzz: false, enable_short_term: false }));

const RATINGS = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };

// A concept is due once predicted recall drops below its target. Core ideas are held to a higher bar.
const TARGET = { 3: 0.9, 2: 0.85, 1: 0.8 };

// Concepts answered this recently are skipped so a session doesn't repeat itself.
const RECENT_LIMIT = 6;
const RECENT_MINUTES = 30;
// When reviews are due, introduce a new concept only if none was introduced in the last N attempts.
const NEW_SPACING = 3;

export function parseCard(json) {
  if (!json) return null;
  const c = JSON.parse(json);
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

export function applyRating(cardJson, rating, at) {
  const card = parseCard(cardJson) ?? createEmptyCard(at);
  return JSON.stringify(f.next(card, at, RATINGS[rating]).card);
}

export function retrievability(cardJson, now) {
  const card = parseCard(cardJson);
  return card ? f.get_retrievability(card, now, false) : null;
}

export function target(importance) {
  return TARGET[importance] ?? 0.9;
}

// Picks the next question, or returns null when nothing is eligible.
export function pickNext(db, now = new Date()) {
  const concepts = db.prepare(
    `SELECT c.id, c.importance, c.card, c.ord, ch.number AS chapter_number
       FROM concepts c JOIN chapters ch ON ch.id = c.chapter_id
      WHERE ch.read_at IS NOT NULL AND c.killed_at IS NULL
        AND EXISTS (SELECT 1 FROM questions q WHERE q.concept_id = c.id AND q.retired = 0 AND q.flagged_at IS NULL)`,
  ).all();
  if (!concepts.length) return null;

  const since = new Date(now - RECENT_MINUTES * 60_000).toISOString();
  const recentRows = db.prepare(
    "SELECT concept_id, kind FROM attempts WHERE at >= ? ORDER BY at DESC, id DESC LIMIT ?",
  ).all(since, RECENT_LIMIT);
  const recent = new Set(recentRows.map((r) => r.concept_id));
  const newRecently = recentRows.slice(0, NEW_SPACING).some((r) => r.kind === "new");

  const fresh = [];
  const due = [];
  const rest = [];
  for (const c of concepts) {
    if (recent.has(c.id)) continue;
    if (!c.card) {
      fresh.push(c);
      continue;
    }
    const r = retrievability(c.card, now);
    const gap = target(c.importance) - r; // positive = below target
    (gap > 0 ? due : rest).push({ ...c, r, gap });
  }

  // New concepts in reading order, most important first within a chapter.
  fresh.sort((a, b) => a.chapter_number - b.chapter_number || b.importance - a.importance || a.ord - b.ord);
  due.sort((a, b) => b.gap - a.gap);
  rest.sort((a, b) => a.r - b.r);

  let choice;
  let kind;
  if (due.length && !(fresh.length && !newRecently)) [choice, kind] = [due[0], "review"];
  else if (fresh.length) [choice, kind] = [fresh[0], "new"];
  else if (due.length) [choice, kind] = [due[0], "review"];
  else if (rest.length) [choice, kind] = [rest[0], "practice"];
  else {
    // Everything eligible was seen in the last few minutes; fall back to the least recent of those.
    const lastSeen = db.prepare("SELECT MAX(at) AS at FROM attempts WHERE concept_id = ?");
    const oldest = concepts
      .map((c) => ({ c, at: lastSeen.get(c.id).at ?? "" }))
      .sort((a, b) => a.at.localeCompare(b.at))[0].c;
    [choice, kind] = [oldest, oldest.card ? "practice" : "new"];
  }

  return { question: pickVariant(db, choice.id), kind };
}

// Within a concept: an unseen variant first (in bank order), else the least recently asked.
function pickVariant(db, conceptId) {
  return db.prepare(
    `SELECT q.*, (SELECT MAX(a.at) FROM attempts a WHERE a.question_id = q.id) AS last_at
       FROM questions q
      WHERE q.concept_id = ? AND q.retired = 0 AND q.flagged_at IS NULL
      ORDER BY last_at IS NOT NULL, last_at, q.ord
      LIMIT 1`,
  ).get(conceptId);
}

// Records the rating on an attempt and advances the concept's card.
export function rateAttempt(db, attemptId, rating) {
  const a = db.prepare("SELECT concept_id, at, rating FROM attempts WHERE id = ?").get(attemptId);
  if (!a || a.rating) return;
  const card = db.prepare("SELECT card FROM concepts WHERE id = ?").get(a.concept_id).card;
  db.prepare("UPDATE attempts SET rating = ? WHERE id = ?").run(rating, attemptId);
  db.prepare("UPDATE concepts SET card = ? WHERE id = ?").run(applyRating(card, rating, new Date(a.at)), a.concept_id);
}
