import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { openDb, syncLibrary, tx } from "./db.js";
import { feedbackAvailable, getFeedback } from "./feedback.js";
import { pickNext, rateAttempt, retrievability, target } from "./scheduler.js";
import { pump, startQueue } from "./generate.js";
import { importBook } from "./library.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const db = openDb(process.env.DATABASE_PATH ?? join(root, "personal-university.db"));

// Load banks, and replay any seed attempts for chapters loaded for the first time.
for (const seed of syncLibrary(db, join(root, "data"))) {
  const { attempts } = JSON.parse(readFileSync(seed.path, "utf8"));
  tx(db, () => {
    attempts.forEach((a, i) => {
      const questionId = `${seed.chapterId}/${a.question}`;
      const q = db.prepare("SELECT concept_id FROM questions WHERE id = ?").get(questionId);
      // Spread same-day seed attempts a minute apart so their order is preserved.
      const at = new Date(Date.parse(a.at) + i * 60_000).toISOString();
      const { lastInsertRowid } = db.prepare(
        "INSERT INTO attempts (question_id, concept_id, at, kind, correct, note) VALUES (?, ?, ?, 'seed', ?, ?)",
      ).run(questionId, q.concept_id, at, a.correct ? 1 : 0, a.note ?? null);
      rateAttempt(db, Number(lastInsertRowid), a.rating);
    });
  });
  console.log(`Seeded ${attempts.length} attempts for ${seed.chapterId}`);
}

const app = new Hono();

const DEPLOYED = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME);

// --- Auth: a short shared PIN, since this app has exactly one user. ---
const PASSWORD = process.env.APP_PASSWORD;
const COOKIE = "pu_session";

// The session cookie is keyed with a random secret kept in the database, not derived from the PIN
// alone: with only 10,000 possible PINs, a PIN-derived cookie could be computed without logging in.
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
let secret = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get()?.value;
if (!secret) {
  secret = randomBytes(32).toString("hex");
  db.prepare("INSERT INTO settings (key, value) VALUES ('session_secret', ?)").run(secret);
}
const sign = (pin) => createHmac("sha256", secret).update(`session:${pin}`).digest("hex");
const sessionToken = PASSWORD && sign(PASSWORD);

// At most 5 wrong PINs per 15 minutes, across all clients. Someone guessing can lock sign-in
// for a while, but the cookie lasts a year, so that rarely matters.
const MAX_FAILURES = 5;
const FAILURE_WINDOW = 15 * 60_000;
let failures = [];

app.post("/login", async (c) => {
  const now = Date.now();
  failures = failures.filter((t) => now - t < FAILURE_WINDOW);
  if (failures.length >= MAX_FAILURES) return c.redirect("/login.html?locked=1");

  const { password } = await c.req.parseBody();
  const given = sign(String(password ?? "").trim());
  if (!PASSWORD || !timingSafeEqual(Buffer.from(given), Buffer.from(sessionToken))) {
    failures.push(now);
    return c.redirect(failures.length >= MAX_FAILURES ? "/login.html?locked=1" : "/login.html?failed=1");
  }
  failures = [];
  setCookie(c, COOKIE, sessionToken, {
    httpOnly: true, secure: new URL(c.req.url).protocol === "https:" || DEPLOYED, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 365,
  });
  return c.redirect("/");
});

// Deployed without a password, serve nothing rather than serve the app to anyone.
app.use("*", async (c, next) => {
  if (!PASSWORD && DEPLOYED && c.req.path !== "/healthz") return c.text("Set APP_PASSWORD to use this app.", 503);
  return next();
});

app.use("*", async (c, next) => {
  const open =["/login.html", "/style.css", "/manifest.webmanifest", "/icon.svg", "/healthz"];
  if (!PASSWORD || open.includes(c.req.path) || getCookie(c, COOKIE) === sessionToken) return next();
  if (c.req.path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
  return c.redirect("/login.html");
});

app.get("/healthz", (c) => c.text("ok"));

// --- Quiz ---
function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// An attempt whose AI feedback never arrived (app closed mid-request) still has to count.
function settleStaleAttempts() {
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  for (const a of db.prepare("SELECT id, correct FROM attempts WHERE rating IS NULL AND at < ?").all(cutoff)) {
    rateAttempt(db, a.id, a.correct ? "good" : "again");
  }
}

app.get("/api/next", (c) => {
  settleStaleAttempts();
  const next = pickNext(db);
  if (!next) {
    const read = db.prepare("SELECT COUNT(*) AS n FROM chapters WHERE read_at IS NOT NULL AND has_bank = 1").get().n;
    return c.json({ empty: read ? "Every question in the chapters you've read is flagged or retired." : "Mark a chapter as read to start." });
  }
  const { question: q, kind } = next;
  const meta = db.prepare(
    `SELECT ch.number, ch.title AS chapter, s.title AS source FROM concepts c
       JOIN chapters ch ON ch.id = c.chapter_id JOIN sources s ON s.id = ch.source_id WHERE c.id = ?`,
  ).get(q.concept_id);
  const options = shuffle([q.answer, ...JSON.parse(q.distractors).map((d) => d.text)]);
  return c.json({
    question: { id: q.id, prompt: q.prompt, level: q.level, reasoning: !!q.reasoning, options },
    kind,
    source: meta.source.split(":")[0],
    chapter: `Ch ${meta.number}`,
    feedbackAvailable: feedbackAvailable(),
  });
});

app.post("/api/answer", async (c) => {
  const { questionId, choice, reasoning, kind: servedAs } = await c.req.json();
  const q = db.prepare(
    "SELECT q.*, c.passage, c.card FROM questions q JOIN concepts c ON c.id = q.concept_id WHERE q.id = ?",
  ).get(questionId);
  if (!q) return c.json({ error: "unknown question" }, 404);

  const distractors = JSON.parse(q.distractors);
  const correct = choice === q.answer;
  const explained = typeof reasoning === "string" && reasoning.trim().length > 0;
  const wantsFeedback = explained && feedbackAvailable();
  const kind = !q.card ? "new" : ["review", "practice"].includes(servedAs) ? servedAs : "review";

  const attemptId = tx(db, () => {
    const { lastInsertRowid } = db.prepare(
      `INSERT INTO attempts (question_id, concept_id, at, kind, choice, correct, reasoning)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(q.id, q.concept_id, new Date().toISOString(), kind, choice, correct ? 1 : 0, explained ? reasoning.trim() : null);
    const id = Number(lastInsertRowid);
    // Without AI feedback the rating is decided now; with it, the tutor's judgment decides.
    if (!wantsFeedback) rateAttempt(db, id, correct ? "good" : "again");
    return id;
  });

  return c.json({
    attemptId,
    correct,
    answer: q.answer,
    why: q.why,
    chosenWhy: correct ? null : distractors.find((d) => d.text === choice)?.why ?? null,
    passage: q.passage,
    feedbackPending: wantsFeedback,
  });
});

app.post("/api/feedback/:attemptId", async (c) => {
  const attempt = db.prepare("SELECT * FROM attempts WHERE id = ?").get(Number(c.req.param("attemptId")));
  if (!attempt?.reasoning) return c.json({ error: "no reasoning on this attempt" }, 400);
  if (attempt.feedback) return c.json({ feedback: attempt.feedback, rating: attempt.rating });
  try {
    const { feedback, rating } = await getFeedback(db, attempt);
    db.prepare("UPDATE attempts SET feedback = ? WHERE id = ?").run(feedback, attempt.id);
    rateAttempt(db, attempt.id, rating);
    return c.json({ feedback, rating });
  } catch (err) {
    console.error("feedback failed", err);
    rateAttempt(db, attempt.id, attempt.correct ? "good" : "again");
    return c.json({ error: "The tutor couldn't respond this time." }, 502);
  }
});

app.post("/api/concepts/:id{.+}/kill", (c) => {
  db.prepare("UPDATE concepts SET killed_at = ? WHERE id = ?").run(new Date().toISOString(), c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/questions/:id{.+}/flag", async (c) => {
  const { note } = await c.req.json().catch(() => ({}));
  db.prepare("UPDATE questions SET flagged_at = ?, flag_note = ? WHERE id = ?").run(
    new Date().toISOString(), note ?? null, c.req.param("id"),
  );
  return c.json({ ok: true });
});

// --- Progress and library ---
const SOLID_DAYS = 7;

app.get("/api/progress", (c) => {
  const now = new Date();
  const sources = db.prepare("SELECT * FROM sources ORDER BY title").all().map((s) => ({
    id: s.id,
    title: s.title,
    authors: s.authors,
    chapters: db.prepare("SELECT * FROM chapters WHERE source_id = ? ORDER BY number").all(s.id).map((ch) => {
      const concepts = db.prepare("SELECT * FROM concepts WHERE chapter_id = ? ORDER BY ord").all(ch.id).map((k) => {
        const r = retrievability(k.card, now);
        // "solid" means memory is expected to last at least a week; recall right after any
        // review is near 100%, so recall alone can't separate a fresh miss from real knowledge.
        const stability = k.card ? JSON.parse(k.card).stability : 0;
        const status = k.killed_at ? "dropped"
          : r === null ? "new"
          : r < target(k.importance) ? "fading"
          : stability >= SOLID_DAYS ? "solid" : "learning";
        const n = db.prepare("SELECT COUNT(*) AS n, SUM(correct) AS right FROM attempts WHERE concept_id = ?").get(k.id);
        return { id: k.id, statement: k.statement, importance: k.importance, status, recall: r, attempts: n.n, correct: n.right ?? 0 };
      });
      return {
        id: ch.id, number: ch.number, title: ch.title, hasBank: !!ch.has_bank, read: !!ch.read_at, concepts,
        status: ch.gen_status, error: ch.gen_error, hasText: ch.text != null,
      };
    }),
  }));
  const totals = db.prepare("SELECT COUNT(*) AS n, SUM(correct) AS right FROM attempts").get();
  return c.json({ sources, totals: { attempts: totals.n, correct: totals.right ?? 0 } });
});

app.post("/api/books", async (c) => {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!file || typeof file === "string") return c.json({ error: "Choose an EPUB file" }, 400);
  try {
    const result = importBook(db, Buffer.from(await file.arrayBuffer()));
    pump();
    return c.json(result);
  } catch (err) {
    console.error("import failed", err);
    return c.json({ error: `Couldn't read that book: ${err.message}` }, 400);
  }
});

app.post("/api/chapters/:id{.+}/generate", (c) => {
  const { changes } = db.prepare(
    "UPDATE chapters SET gen_status = 'queued', gen_error = NULL WHERE id = ? AND text IS NOT NULL AND gen_status = 'failed'",
  ).run(c.req.param("id"));
  pump();
  return c.json({ ok: changes > 0 });
});

app.post("/api/chapters/:id{.+}/read", async (c) => {
  const { read } = await c.req.json();
  db.prepare("UPDATE chapters SET read_at = ? WHERE id = ?").run(read ? new Date().toISOString() : null, c.req.param("id"));
  return c.json({ ok: true });
});

app.use("/*", serveStatic({ root: join(root, "public") }));

const port = Number(process.env.PORT ?? 3000);
startQueue(db);
serve({ fetch: app.fetch, port }, () => {
  console.log(`Personal University on http://localhost:${port}`);
  if (!PASSWORD) console.warn("APP_PASSWORD is not set: the app is open to anyone who can reach it.");
  if (!feedbackAvailable()) console.warn("ANTHROPIC_API_KEY is not set: answers work, AI feedback is off.");
});
