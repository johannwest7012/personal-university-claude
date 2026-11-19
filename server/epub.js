// Turns an EPUB into a list of sections (chapters) of plain text, using the book's own
// table of contents for boundaries and titles, and its reading order (spine) for content.
import { strFromU8, unzipSync } from "fflate";
import { posix } from "node:path";

const BACK_MATTER = /^(notes?|endnotes|index|bibliography|references|works cited|sources|further reading|acknowledg(e)?ments?|about the authors?|copyright|contents|table of contents|title page|cover|glossary|also by|praise for|dedication|epigraph)\b/i;
// Sections shorter than this are part dividers, epigraphs and the like.
const MIN_WORDS = 1200;

const decode = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function htmlToText(html) {
  return decode(
    html
      .replace(/<head[\s\S]*?<\/head>/i, "")
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
      .replace(/<sup[^>]*>[\s\S]*?<\/sup>/gi, "") // footnote markers
      .replace(/<\/(p|h[1-6]|div|li|blockquote|tr|section|figcaption)>/gi, "\n\n")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i"))?.[1];

export function parseEpub(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const read = (path) => {
    const f = files[path] ?? files[decodeURIComponent(path)];
    if (!f) throw new Error(`EPUB is missing ${path}`);
    return strFromU8(f);
  };

  const opfPath = attr(read("META-INF/container.xml").match(/<rootfile\s[^>]*>/i)[0], "full-path");
  const opf = read(opfPath);
  const base = posix.dirname(opfPath);
  const resolve = (from, href) => posix.normalize(posix.join(posix.dirname(from), href.split("#")[0]));

  const title = decode(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.trim() ?? "Untitled");
  const authors = [...opf.matchAll(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/gi)].map((m) => decode(m[1].trim()));

  const manifest = new Map();
  for (const [tag] of opf.matchAll(/<item\b[^>]*>/gi)) {
    manifest.set(attr(tag, "id"), { href: posix.join(base, attr(tag, "href")), props: attr(tag, "properties") ?? "", type: attr(tag, "media-type") });
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*>/gi)].map(([tag]) => manifest.get(attr(tag, "idref"))?.href).filter(Boolean);

  // Table of contents: EPUB 3 nav document if present, else the EPUB 2 NCX.
  let toc = [];
  const nav = [...manifest.values()].find((m) => m.props.split(/\s+/).includes("nav"));
  if (nav) {
    const doc = read(nav.href);
    const tocNav = doc.match(/<nav[^>]*epub:type\s*=\s*["']toc["'][^>]*>([\s\S]*?)<\/nav>/i)?.[1] ?? "";
    toc = [...tocNav.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map((m) => ({ file: resolve(nav.href, m[1]), title: htmlToText(m[2]) }));
  }
  if (!toc.length) {
    const ncxItem = [...manifest.values()].find((m) => m.type === "application/x-dtbncx+xml");
    if (ncxItem) {
      const ncx = read(ncxItem.href);
      const navMap = ncx.match(/<navMap[^>]*>([\s\S]*?)<\/navMap>/i)?.[1] ?? "";
      toc = [...navMap.matchAll(/<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\s+src\s*=\s*"([^"]+)"/gi)]
        .map((m) => ({ file: resolve(ncxItem.href, m[2]), title: decode(m[1].trim()) }));
    }
  }

  // Each TOC entry starts a section running up to the spine position of the next entry.
  const starts = [];
  for (const entry of toc) {
    const i = spine.indexOf(entry.file);
    if (i >= 0 && !starts.some((s) => s.index === i)) starts.push({ index: i, title: entry.title });
  }
  starts.sort((a, b) => a.index - b.index);
  if (!starts.length) throw new Error("Couldn't find a table of contents in this EPUB");

  const sections = starts.map((s, k) => {
    const end = k + 1 < starts.length ? starts[k + 1].index : spine.length;
    const text = spine.slice(s.index, end).map((f) => htmlToText(read(f))).join("\n\n");
    const words = text.split(/\s+/).filter(Boolean).length;
    return { title: s.title, text, words };
  });

  return {
    title,
    authors,
    sections: sections.filter((s) => s.words >= MIN_WORDS && !BACK_MATTER.test(s.title.replace(/^\d+[.:]?\s*/, ""))),
    skipped: sections.filter((s) => s.words < MIN_WORDS || BACK_MATTER.test(s.title.replace(/^\d+[.:]?\s*/, ""))).map((s) => s.title),
  };
}

// For matching an uploaded chapter to one already in the library: "2 Blue Origin: Step by Step"
// and "Chapter 2: Blue Origin" style prefixes are ignored.
export function normalizeTitle(t) {
  return t.toLowerCase().replace(/^(chapter\s+)?\d+[.:]?\s*/, "").replace(/[^a-z0-9]+/g, " ").trim();
}
