// SQLite storage, plus syncing the question banks in data/ into it on boot.
// Banks are the source of truth for content; the database owns everything the
// learner does (reads, attempts, scheduling state, kills and flags).
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  authors TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chapters (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  has_bank INTEGER NOT NULL DEFAULT 0,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS concepts (
  id TEXT PRIMARY KEY,               -- "<chapter id>/<concept slug>"
  chapter_id TEXT NOT NULL REFERENCES chapters(id),
  ord INTEGER NOT NULL,
  importance INTEGER NOT NULL,
  statement TEXT NOT NULL,
  passage TEXT NOT NULL,
  card TEXT,                         -- FSRS card JSON; NULL until first attempt
  killed_at TEXT
);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,               -- "<chapter id>/<concept slug>/<n>"
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  ord INTEGER NOT NULL,
  level TEXT NOT NULL,
  reasoning INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  why TEXT NOT NULL,
  distractors TEXT NOT NULL,         -- JSON [{text, why}]
  retired INTEGER NOT NULL DEFAULT 0,-- no longer in the bank
  flagged_at TEXT,
  flag_note TEXT
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id TEXT NOT NULL REFERENCES questions(id),
  concept_id TEXT NOT NULL REFERENCES concepts(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,                -- new | review | practice | seed
  choice TEXT,
  correct INTEGER NOT NULL,
  reasoning TEXT,
  rating TEXT,                       -- again | hard | good | easy; NULL while AI feedback is pending
  feedback TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS attempts_concept ON attempts(concept_id, at);
CREATE INDEX IF NOT EXISTS attempts_at ON attempts(at);
`;

// Columns added after the first deploy. SQLite has no ADD COLUMN IF NOT EXISTS.
const MIGRATIONS = [
  ["chapters", "text", "TEXT"],                 // plain text of an uploaded chapter
  ["chapters", "words", "INTEGER"],
  ["chapters", "gen_status", "TEXT"],           // NULL | queued | running | ready | failed
  ["chapters", "gen_error", "TEXT"],
];

export function openDb(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  for (const [table, column, type] of MIGRATIONS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// Upserts every source, chapter, concept and question found under dataDir.
// Returns the seed attempts files for chapters whose bank was loaded for the first time.
export function syncLibrary(db, dataDir) {
  const seeds = [];
  const now = new Date().toISOString();
  tx(db, () => {
    for (const dir of readdirSync(dataDir, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const base = join(dataDir, dir.name);
      const sourcePath = join(base, "source.json");
      if (!existsSync(sourcePath)) continue;
      const source = JSON.parse(readFileSync(sourcePath, "utf8"));

      db.prepare(
        `INSERT INTO sources (id, title, authors) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, authors = excluded.authors`,
      ).run(source.id, source.title, source.authors.join(", "));

      for (const ch of source.chapters) {
        const existing = db.prepare("SELECT id, has_bank FROM chapters WHERE id = ?").get(ch.id);
        const hasBank = ch.bank ? 1 : 0;
        if (!existing) {
          db.prepare(
            "INSERT INTO chapters (id, source_id, number, title, has_bank, read_at, gen_status) VALUES (?, ?, ?, ?, ?, ?, ?)",
          ).run(ch.id, source.id, ch.number, ch.title, hasBank, ch.readOnSeed ? now : null, hasBank ? "ready" : null);
        } else if (hasBank) {
          // Title and order may since have come from an uploaded EPUB; only record the bank.
          db.prepare("UPDATE chapters SET has_bank = 1, gen_status = 'ready' WHERE id = ?").run(ch.id);
        }
        if (!ch.bank) continue;
        const bankPath = join(base, ch.bank);
        loadBank(db, ch.id, JSON.parse(readFileSync(bankPath, "utf8")));
        const seedPath = bankPath.replace(/\.json$/, "-attempts.json");
        if (!existing?.has_bank && existsSync(seedPath)) seeds.push({ chapterId: ch.id, path: seedPath });
      }
    }
  });
  return seeds;
}

export function loadBank(db, chapterId, bank) {
  const upsertConcept = db.prepare(
    `INSERT INTO concepts (id, chapter_id, ord, importance, statement, passage) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET ord = excluded.ord, importance = excluded.importance,
       statement = excluded.statement, passage = excluded.passage`,
  );
  const upsertQuestion = db.prepare(
    `INSERT INTO questions (id, concept_id, ord, level, reasoning, prompt, answer, why, distractors, retired)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET concept_id = excluded.concept_id, ord = excluded.ord, level = excluded.level,
       reasoning = excluded.reasoning, prompt = excluded.prompt, answer = excluded.answer, why = excluded.why,
       distractors = excluded.distractors, retired = 0`,
  );
  // Questions dropped from the bank stay in the table (attempts reference them) but stop being served.
  db.prepare(
    "UPDATE questions SET retired = 1 WHERE concept_id IN (SELECT id FROM concepts WHERE chapter_id = ?)",
  ).run(chapterId);

  bank.concepts.forEach((c, i) => {
    const conceptId = `${chapterId}/${c.id}`;
    upsertConcept.run(conceptId, chapterId, i, c.importance, c.statement, c.passage);
    c.questions.forEach((q, j) => {
      upsertQuestion.run(
        `${chapterId}/${q.id}`, conceptId, j, q.level, q.reasoning ? 1 : 0,
        q.prompt, q.answer, q.why, JSON.stringify(q.distractors),
      );
    });
  });
}
