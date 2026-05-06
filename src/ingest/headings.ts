const JOIN_WORDS = new Set([
  "a",
  "an",
  "the",
  "of",
  "and",
  "in",
  "on",
  "at",
  "to",
  "for",
  "or",
  "as",
  "by",
]);

export type PageSegment = {
  pageNumber: number;
  /** Section title detected immediately before this body text */
  sectionHeading?: string;
  content: string;
};

/**
 * Heuristic heading line for PDF/Markdown-ish text (no layout engine).
 * Tuned for rulebooks: ALL CAPS labels, Title Case section titles, markdown # headers.
 */
export function tryParseHeadingLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const md = trimmed.match(/^#{1,6}\s+(.+?)(?:\s+#*)?$/);
  if (md) {
    const inner = md[1].trim();
    return inner.length >= 2 ? inner : null;
  }

  if (trimmed.length < 4 || trimmed.length > 72) return null;
  if (/[.!?:]$/.test(trimmed)) return null;

  const letters = trimmed.replace(/[^a-z]/gi, "");
  if (letters.length >= 4) {
    const upperCount = [...letters].filter(
      (ch) => ch === ch.toUpperCase(),
    ).length;
    if (upperCount / letters.length > 0.85) return trimmed;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 1) {
    const w = words[0];
    if (
      w.length >= 4 &&
      w.length <= 48 &&
      /^[A-Z][\p{L}'’0-9\-]*$/u.test(w) &&
      /[a-z]/u.test(w)
    ) {
      return trimmed;
    }
  }

  if (words.length >= 2 && words.length <= 10) {
    const titleish = words.every((w) => {
      if (JOIN_WORDS.has(w.toLowerCase())) return true;
      return /^[A-Z0-9][\w'’\-]*$/u.test(w) || /^\d+$/.test(w);
    });
    if (titleish && words.some((w) => !JOIN_WORDS.has(w.toLowerCase()))) {
      return trimmed;
    }
  }

  return null;
}

/**
 * Split one page into body segments at detected headings. Preserves reading order
 * for typical `unpdf` line breaks; single-line pages stay one segment.
 */
export function splitPageIntoSegments(
  pageNumber: number,
  content: string,
): PageSegment[] {
  const lines = content.split(/\n/);
  const segments: PageSegment[] = [];
  let pendingHeading: string | undefined;
  const buf: string[] = [];

  const flush = () => {
    const text = buf.join(" ").replace(/\s+/g, " ").trim();
    buf.length = 0;
    if (!text) return;
    segments.push({
      pageNumber,
      sectionHeading: pendingHeading,
      content: text,
    });
  };

  for (const line of lines) {
    const h = tryParseHeadingLine(line);
    if (h) {
      flush();
      pendingHeading = h;
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    buf.push(t);
  }
  flush();

  if (segments.length === 0) {
    const fallback = content.replace(/\s+/g, " ").trim();
    if (fallback) return [{ pageNumber, content: fallback }];
  }

  return segments;
}
