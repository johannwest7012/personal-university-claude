// Adding a book from an EPUB: store each chapter's text and queue question generation.
import { normalizeTitle, parseEpub } from "./epub.js";
import { tx } from "./db.js";

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export function importBook(db, buffer) {
  const book = parseEpub(buffer);
  if (!book.sections.length) throw new Error("No chapters long enough to quiz on were found in this EPUB");

  // "Space to Grow: Unlocking the Final Economic Frontier" -> "space-to-grow", so a book whose
  // first chapter shipped with the app lands on the same record.
  const sourceId = slug(book.title.split(":")[0]);
  const authors = book.authors.join(", ") || "Unknown author";

  return tx(db, () => {
    db.prepare(
      `INSERT INTO sources (id, title, authors) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, authors = excluded.authors`,
    ).run(sourceId, book.title, authors);

    const existing = db.prepare("SELECT id, title FROM chapters WHERE source_id = ?").all(sourceId);
    const byTitle = new Map(existing.map((c) => [normalizeTitle(c.title), c.id]));
    const taken = new Set(existing.map((c) => c.id));
    let queued = 0;

    book.sections.forEach((section, i) => {
      let id = byTitle.get(normalizeTitle(section.title));
      if (!id) {
        id = `${sourceId}/${slug(section.title.replace(/^\d+[.:]?\s*/, "")) || `section-${i + 1}`}`;
        while (taken.has(id)) id += "-x";
        taken.add(id);
        db.prepare("INSERT INTO chapters (id, source_id, number, title) VALUES (?, ?, ?, ?)").run(id, sourceId, i, section.title);
      }
      db.prepare("UPDATE chapters SET number = ?, title = ?, text = ?, words = ? WHERE id = ?").run(
        i, section.title, section.text, section.words, id,
      );
      // Chapters that already have questions keep them; everything else gets written.
      const { changes } = db.prepare(
        "UPDATE chapters SET gen_status = 'queued', gen_error = NULL WHERE id = ? AND has_bank = 0 AND (gen_status IS NULL OR gen_status = 'failed')",
      ).run(id);
      queued += changes;
    });

    return { sourceId, title: book.title, chapters: book.sections.length, queued, skipped: book.skipped };
  });
}
