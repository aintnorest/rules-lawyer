import { normalizeIndexKey } from "./index-hints";

type Page = { pageNumber: number; content: string };

export type IndexExtractOptions = {
  /** Fraction of pages (from end) to scan, after min/max clamp. */
  tailFraction?: number;
  minTailPages?: number;
  maxTailPages?: number;
  /** With an “Index” heading, keep when at least this many entries. */
  minEntriesWithHeading?: number;
  /** Without a clear heading, require this many lines to reduce false positives. */
  minEntriesHeuristic?: number;
};

const DEFAULTS: Required<IndexExtractOptions> = {
  tailFraction: 0.22,
  minTailPages: 14,
  maxTailPages: 95,
  minEntriesWithHeading: 6,
  minEntriesHeuristic: 22,
};

const SKIP_TOPIC = new Set([
  "index",
  "contents",
  "table of contents",
  "introduction",
  "appendix",
  "appendices",
  "references",
  "bibliography",
  "glossary",
]);

function cleanLine(line: string): string {
  return line
    .replace(/\.{3,}/g, " ")
    .replace(/…+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitIntoLines(content: string): string[] {
  const byNl = content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (byNl.length >= 5) return byNl;
  return content
    .split(/\s{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tryParseIndexLine(
  line: string,
): { topic: string; pages: number[] } | null {
  if (/^see\b/i.test(line)) return null;
  if (/^\d+[.,]\s/.test(line)) return null;

  const m = line.match(/^(.+?)\s+(\d{1,4}(?:\s*,\s*\d{1,4})*)\s*$/);
  if (!m) return null;

  let topic = m[1]
    .trim()
    .replace(/[.,;:]+$/u, "")
    .trim();
  const pages = m[2]
    .split(/\s*,\s*/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 5000);

  if (pages.length === 0 || topic.length < 2 || topic.length > 160) return null;
  if (/^\d+$/.test(topic)) return null;

  topic = topic.replace(/\s+/g, " ");
  const low = topic.toLowerCase();
  if (SKIP_TOPIC.has(low)) return null;
  if (topic.split(/\s+/).length > 16) return null;

  return normalizeIndexKey(topic) === "" ? null : { topic, pages };
}

function mergeEntry(
  entries: Record<string, number[]>,
  topic: string,
  pages: number[],
) {
  const norm = normalizeIndexKey(topic);
  const existingKey = Object.keys(entries).find(
    (k) => normalizeIndexKey(k) === norm,
  );
  const useKey = existingKey ?? topic;
  const set = new Set(entries[useKey] ?? []);
  for (const p of pages) set.add(p);
  entries[useKey] = [...set].sort((a, b) => a - b);
}

/**
 * Heuristic extraction of back-of-book style index lines (topic + page number).
 * Works on the same `pageNumber` space as chunks (1-based PDF page from unpdf).
 */
export function extractIndexHintsFromPages(
  pages: Page[],
  options?: IndexExtractOptions,
): { entries: Record<string, number[]>; usedIndexHeading: boolean } {
  const o = { ...DEFAULTS, ...options };
  const n = pages.length;
  const entries: Record<string, number[]> = {};
  if (n === 0) return { entries, usedIndexHeading: false };

  let tailLen = Math.max(o.minTailPages, Math.floor(n * o.tailFraction));
  tailLen = Math.min(tailLen, o.maxTailPages, n);
  const tail = pages.slice(n - tailLen);

  let indexStart = 0;
  let usedIndexHeading = false;
  for (let i = 0; i < tail.length; i++) {
    const head = tail[i].content.slice(0, 1200);
    if (
      /(^|\n)\s*index\s*(\n|$)/i.test(head) ||
      /\n\s*index\s*\n/i.test(tail[i].content) ||
      /^\s*index\s*$/im.test(tail[i].content)
    ) {
      indexStart = i;
      usedIndexHeading = true;
      break;
    }
  }

  const region = tail.slice(indexStart);
  for (const p of region) {
    for (const raw of splitIntoLines(p.content)) {
      const line = cleanLine(raw);
      if (line.length < 4) continue;
      const parsed = tryParseIndexLine(line);
      if (parsed) mergeEntry(entries, parsed.topic, parsed.pages);
    }
  }

  const count = Object.keys(entries).length;
  const keep =
    count > 0 &&
    ((usedIndexHeading && count >= o.minEntriesWithHeading) ||
      (!usedIndexHeading && count >= o.minEntriesHeuristic));

  if (!keep) {
    return { entries: {}, usedIndexHeading };
  }

  return { entries, usedIndexHeading };
}
