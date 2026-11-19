import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { openDb } from "../server/db.js";
import { parseEpub } from "../server/epub.js";
import { cleanBank, generateBank, startQueue } from "../server/generate.js";
import { importBook, queueChapter } from "../server/library.js";

const para = (topic, n) => Array.from({ length: n }, (_, i) => `<p>Sentence ${i} about ${topic} explains why ${topic} matters to the argument.</p>`).join("");
const page = (title, body) => `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`;

function makeEpub() {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    "OPS/book.opf": strToU8(`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/"><metadata><dc:title>Test Book: A Subtitle</dc:title><dc:creator>Ada Author</dc:creator></metadata>
      <manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
      <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="part" href="part.xhtml" media-type="application/xhtml+xml"/>
      <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/><item id="c2b" href="c2b.xhtml" media-type="application/xhtml+xml"/>
      <item id="notes" href="notes.xhtml" media-type="application/xhtml+xml"/></manifest>
      <spine><itemref idref="c1"/><itemref idref="part"/><itemref idref="c2"/><itemref idref="c2b"/><itemref idref="notes"/></spine></package>`),
    "OPS/nav.xhtml": strToU8(`<html><body><nav epub:type="toc"><ol>
      <li><a href="c1.xhtml">1. Rockets</a></li><li><a href="part.xhtml">Part Two</a></li>
      <li><a href="c2.xhtml#start">2. Stations</a></li><li><a href="notes.xhtml">Notes</a></li></ol></nav></body></html>`),
    "OPS/c1.xhtml": strToU8(page("Rockets", para("rockets", 120))),
    "OPS/part.xhtml": strToU8(page("Part Two", "<p>A divider.</p>")),
    "OPS/c2.xhtml": strToU8(page("Stations", para("stations", 80))),
    "OPS/c2b.xhtml": strToU8(page("Stations, continued", para("orbits", 60))),
    "OPS/notes.xhtml": strToU8(page("Notes", para("citations", 200))),
  });
}

test("parses chapters from the TOC and spine, skipping dividers and back matter", () => {
  const book = parseEpub(makeEpub());
  assert.equal(book.title, "Test Book: A Subtitle");
  assert.deepEqual(book.sections.map((s) => s.title), ["1. Rockets", "2. Stations"]);
  // A chapter spanning two spine files keeps both.
  assert.match(book.sections[1].text, /orbits/);
  assert.deepEqual(book.skipped, ["Part Two", "Notes"]);
});

test("passages that aren't verbatim and malformed questions are dropped", () => {
  const text = "The shuttle averaged fewer than five flights a year.";
  const q = { level: "recall", reasoning: false, prompt: "P?", answer: "A", why: "W", distractors: [{ text: "B", why: "x" }, { text: "C", why: "x" }, { text: "D", why: "x" }] };
  const { concepts, dropped } = cleanBank({
    concepts: [
      { slug: "Flight Rate", importance: 3, statement: "S", passage: "the shuttle averaged fewer than five flights", questions: [q, { ...q, distractors: q.distractors.slice(0, 2) }] },
      { slug: "made-up", importance: 2, statement: "S", passage: "The shuttle flew sixty times a year.", questions: [q] },
    ],
  }, text);
  assert.deepEqual(concepts.map((c) => c.id), ["flight-rate"]);
  assert.deepEqual(concepts[0].questions.map((x) => x.id), ["flight-rate/1"]);
  assert.equal(dropped.length, 2);
});

test("chapters are written only when checked off or requested, and not twice", async () => {
  const db = openDb(":memory:");
  const out = importBook(db, makeEpub());
  assert.equal(out.sourceId, "test-book");
  assert.equal(out.queued, 0, "uploading writes nothing by itself");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM chapters WHERE gen_status IS NOT NULL").get().n, 0);

  // Checking off a chapter queues it; "Write now" queues one that isn't checked off.
  db.prepare("UPDATE chapters SET read_at = 'now' WHERE id = 'test-book/rockets'").run();
  assert.equal(queueChapter(db, "test-book/rockets"), 1);
  assert.equal(queueChapter(db, "test-book/rockets"), 0, "not queued twice");
  assert.equal(queueChapter(db, "test-book/stations"), 1);

  // Stand-in for Claude: both passes return a bank quoting the chapter verbatim.
  const calls = [];
  const fake = async (system, user) => {
    calls.push(system.slice(0, 20));
    const topic = user.includes("rockets") ? "rockets" : "stations";
    const q = (n) => ({ level: "recall", reasoning: false, prompt: `Q${n} on ${topic}?`, answer: "Right", why: "Because.", distractors: ["X", "Y", "Z"].map((t) => ({ text: t + n, why: "No." })) });
    return {
      notes: "",
      concepts: [1, 2, 3].map((n) => ({ slug: `${topic}-${n}`, importance: 3, statement: `Idea ${n}`, passage: `Sentence ${n} about ${topic} explains why ${topic} matters`, questions: [q(n)] })),
    };
  };
  startQueue(db, fake);
  for (let i = 0; i < 50 && db.prepare("SELECT COUNT(*) n FROM chapters WHERE gen_status = 'ready'").get().n < 2; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(calls.length, 4, "two passes per chapter");
  const chapters = db.prepare("SELECT id, has_bank, gen_status FROM chapters ORDER BY number").all();
  assert.deepEqual(chapters.map((c) => [c.id, c.has_bank, c.gen_status]), [
    ["test-book/rockets", 1, "ready"],
    ["test-book/stations", 1, "ready"],
  ]);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM questions WHERE concept_id LIKE 'test-book/rockets/%'").get().n, 3);

  // Uploading again doesn't touch chapters that already have questions.
  importBook(db, makeEpub());
  assert.equal(queueChapter(db, "test-book/rockets"), 0);
});

test("generation failures are recorded for retry", async () => {
  const db = openDb(":memory:");
  importBook(db, makeEpub());
  queueChapter(db, "test-book/rockets");
  queueChapter(db, "test-book/stations");
  startQueue(db, async () => { throw new Error("overloaded"); });
  for (let i = 0; i < 50 && db.prepare("SELECT COUNT(*) n FROM chapters WHERE gen_status = 'failed'").get().n < 2; i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const failed = db.prepare("SELECT gen_error FROM chapters WHERE gen_status = 'failed'").all();
  assert.equal(failed.length, 2);
  assert.equal(failed[0].gen_error, "overloaded");
});

test("generateBank sends the chapter to both passes", async () => {
  const seen = [];
  const fake = async (system, user) => {
    seen.push(user.includes("<chapter>") && user.includes("orbital mechanics"));
    return { notes: "ok", concepts: [] };
  };
  await generateBank("Book", "Ch", "Text about orbital mechanics.", fake);
  assert.deepEqual(seen, [true, true]);
});

test("a chapter checked off before its book was uploaded is queued on upload", () => {
  const db = openDb(":memory:");
  db.prepare("INSERT INTO sources (id, title, authors) VALUES ('test-book', 'Test Book', 'A')").run();
  db.prepare("INSERT INTO chapters (id, source_id, number, title, read_at) VALUES ('test-book/ch2', 'test-book', 2, 'Stations', 'now')").run();
  assert.equal(importBook(db, makeEpub()).queued, 1);
  assert.equal(db.prepare("SELECT gen_status FROM chapters WHERE id = 'test-book/ch2'").get().gen_status, "queued");
});
