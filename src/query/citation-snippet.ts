import { scoreAnswerSupportBestClause } from "./citation-alignment";
import { excerptContainsStackingRuleText } from "./retrieval";

/** Section-like breaks that commonly follow dense rule blocks in two-column PDFs. */
const POST_RULE_STOP_PATTERNS: RegExp[] = [
  /\bThe Environment\b/,
  /\.(?:\s|\n)+Objects\b/,
  /\nObjects\b/,
  /\nObstacles\b/,
];

/** Prefer an anchored block when chunks bundle many micro-sections on one PDF page. */
const ANCHORED_SECTION_HEADINGS: RegExp[] = [/\bMultiple Afflictions\b/i];

/**
 * Narrow stored chunk span text for citation display. Deterministic server-side slice;
 * never uses the LLM.
 */
export function focusCitationSnippetForDisplay(
  fullBody: string,
  answer: string,
): string {
  const a = answer.trim();
  const body = fullBody.trim();
  if (!body || !a || body.length < 420) return body;

  const anchored = extractAnchoredRuleBlock(body);
  if (
    anchored &&
    anchored.length >= 80 &&
    anchored.length <= body.length * 0.98
  ) {
    return capAtSentenceBoundary(anchored, 960);
  }

  const windowed = bestAnswerAlignedWindow(body, a);
  return windowed !== body ? capAtSentenceBoundary(windowed.trim(), 960) : body;
}

function extractAnchoredRuleBlock(body: string): string | null {
  for (const re of ANCHORED_SECTION_HEADINGS) {
    const m = re.exec(body);
    if (m?.index === undefined || m.index < 0) continue;
    const from = m.index;
    const tail = body.slice(from);
    let end = tail.length;
    for (const stop of POST_RULE_STOP_PATTERNS) {
      const s = stop.exec(tail);
      if (s?.index !== undefined && s.index >= 120)
        end = Math.min(end, s.index);
    }
    const block = tail.slice(0, end).trim();
    if (block.length >= 80) return block;
  }

  if (excerptContainsStackingRuleText(body)) {
    const idx = earliestStackingPhraseIndex(body);
    if (idx >= 0) {
      const tail = body.slice(idx);
      let end = tail.length;
      for (const stop of POST_RULE_STOP_PATTERNS) {
        const s = stop.exec(tail);
        if (s?.index !== undefined && s.index >= 80)
          end = Math.min(end, s.index);
      }
      const block = tail.slice(0, end).trim();
      if (block.length >= 60) return block;
    }
  }

  return null;
}

function earliestStackingPhraseIndex(body: string): number {
  const needles = [
    /\bmultiple afflictions\b/i,
    /\bno additional effect\b/i,
    /\bgain an affliction you already have\b/i,
    /\beach instance of the affliction\b/i,
    /\bremove each instance\b/i,
  ];
  let best = -1;
  for (const re of needles) {
    const m = re.exec(body);
    if (m?.index !== undefined && m.index >= 0) {
      if (best < 0 || m.index < best) best = m.index;
    }
  }
  return best;
}

const WINDOW = 460;
const WINDOW_STEP = 48;

function bestAnswerAlignedWindow(body: string, answer: string): string {
  if (body.length <= WINDOW + 120) return body;
  let bestStart = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i + WINDOW <= body.length; i += WINDOW_STEP) {
    const w = body.slice(i, i + WINDOW);
    const score = scoreAnswerSupportBestClause(answer, w);
    if (score > bestScore) {
      bestScore = score;
      bestStart = i;
    }
  }
  let lo = Math.max(0, bestStart - 32);
  let hi = Math.min(body.length, bestStart + WINDOW + 72);
  if (lo > 0) {
    const sp = body.lastIndexOf(" ", lo + 48);
    if (sp > lo - 48) lo = sp + 1;
  }
  if (hi < body.length) {
    const sp = body.indexOf(" ", Math.max(bestStart + WINDOW - 48, hi - 96));
    if (sp >= bestStart && sp < hi) hi = Math.min(hi, sp + 96);
  }
  return body.slice(lo, hi);
}

function capAtSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const last = Math.max(slice.lastIndexOf("."), slice.lastIndexOf("!"));
  if (last >= maxChars * 0.5) return `${slice.slice(0, last + 1).trim()}…`;
  const sp = slice.lastIndexOf(" ");
  if (sp >= maxChars * 0.6) return `${slice.slice(0, sp).trim()}…`;
  return `${slice.trim()}…`;
}
