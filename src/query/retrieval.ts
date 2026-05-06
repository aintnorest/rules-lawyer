import { normalizeConcept } from "../lib/concepts";
import { chunkTextWithHeading } from "../lib/chunk-text";
import type { Chunk } from "../types";

/** Terms ignored when mining the question for lexical retrieval / citation fallback. */
const STOPWORDS = new Set([
  "does",
  "do",
  "did",
  "what",
  "when",
  "where",
  "which",
  "that",
  "this",
  "with",
  "from",
  "have",
  "has",
  "your",
  "you",
  "the",
  "and",
  "but",
  "for",
  "not",
  "can",
  "how",
  "why",
  "its",
  "our",
  "are",
  "was",
  "were",
  "been",
  "being",
  "into",
  "than",
  "then",
  "them",
  "they",
  "their",
  "about",
  "also",
  "any",
  "book",
  "rule",
  "rules",
  "game",
  "please",
]);

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fraction of `terms` that appear as whole words in `text` (0–1). */
export function lexicalMatchRatio(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const raw of terms) {
    const t = raw.toLowerCase();
    if (t.length < 2) continue;
    const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, "i");
    if (re.test(lower)) hits++;
  }
  return hits / terms.length;
}

export function countTermHitsInText(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const raw of terms) {
    const t = raw.toLowerCase();
    if (t.length < 2) continue;
    const re = new RegExp(`\\b${escapeRegExp(t)}\\b`, "gi");
    const m = lower.match(re);
    if (m) hits += m.length;
  }
  return hits;
}

/**
 * Tokenize the user question into content words, plus light expansion when the
 * user asks about stacking / duplicates (boosts chunks with "Multiple Afflictions"-style wording).
 */
export function retrievalTermsFromQuestion(question: string): string[] {
  const raw = question.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const base = [
    ...new Set(
      raw
        .map((w) => w.replace(/^'|'$/g, ""))
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
    ),
  ];
  const expanded = [...base];
  if (
    /\b(stack|stacks|stacking|duplicate|duplicates|twice|again|multiple)\b/i.test(
      question,
    )
  ) {
    for (const x of [
      "multiple",
      "affliction",
      "afflictions",
      "additional",
      "already",
    ]) {
      if (!expanded.includes(x)) expanded.push(x);
    }
  }
  return expanded;
}

/**
 * Normalized phrases mined from the question for matching against zettel
 * **`definesConcepts`** during retrieval (additive pool seed — see `retrieveDefineConceptWeight`).
 */
export function conceptQueryPhrases(question: string): string[] {
  const trimmed = question.trim();
  if (!trimmed) return [];

  const fromRetrieval = retrievalTermsFromQuestion(trimmed);
  const out = new Set<string>();
  for (const t of fromRetrieval) {
    const n = normalizeConcept(t);
    if (n.length >= 3) out.add(n);
  }

  const words =
    trimmed
      .toLowerCase()
      .match(/[a-z0-9']+/g)
      ?.map((w) => w.replace(/^'+|'+$/g, ""))
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)) ?? [];

  for (let len = 2; len <= Math.min(3, words.length); len++) {
    for (let i = 0; i + len <= words.length; i++) {
      const phrase = normalizeConcept(words.slice(i, i + len).join(" "));
      if (phrase.length >= 5) out.add(phrase);
    }
  }

  return [...out].slice(0, 64);
}

const STACKING_RULE_PHRASES: { re: RegExp; w: number }[] = [
  { re: /\bmultiple afflictions\b/i, w: 0.12 },
  { re: /\bno additional effect\b/i, w: 0.15 },
  { re: /\bgain an affliction you already have\b/i, w: 0.16 },
  { re: /\beach instance of the affliction\b/i, w: 0.1 },
  { re: /\bremove each instance\b/i, w: 0.1 },
];

/** True when text contains book-style multi-affliction / instance rules (used for retrieval and citation repair). */
export function excerptContainsStackingRuleText(text: string): boolean {
  return STACKING_RULE_PHRASES.some(({ re }) => re.test(text));
}

/**
 * For stacking / duplicate questions: keep a citation if the excerpt matches the rule
 * wording or shares substantive terms with the question (drops irrelevant same-page picks).
 */
export function snippetSupportsStackingQuery(
  question: string,
  snippet: string,
): boolean {
  if (!questionMentionsStackingOrDuplicates(question)) return true;
  if (excerptContainsStackingRuleText(snippet)) return true;
  const terms = retrievalTermsFromQuestion(question);
  if (terms.length === 0) return true;
  return countTermHitsInText(snippet, terms) > 0;
}

export function questionMentionsStackingOrDuplicates(
  question: string,
): boolean {
  return /\b(stack|stacks|stacking|duplicate|duplicates|twice|again|multiple)\b/i.test(
    question,
  );
}

/** True when the answer paraphrases mechanics that usually come from multi-instance rules, not a single-line glossary. */
export function answerMentionsMultiInstanceMechanics(answer: string): boolean {
  return (
    excerptContainsStackingRuleText(answer) ||
    /\b(each\s+instance|remove\s+each|instances?\s+of|already\s+have|no\s+additional|same\s+affliction)\b/i.test(
      answer,
    ) ||
    /\b(stack|stacks|stacking)\b/i.test(answer)
  );
}

/** Extra dense-score boost when the question is about stacking/duplicates and the chunk has core-rulebook style wording. */
export function stackingRulePhraseBoost(
  question: string,
  text: string,
): number {
  if (
    !/\b(stack|stacks|stacking|duplicate|duplicates|twice|again|multiple)\b/i.test(
      question,
    )
  ) {
    return 0;
  }
  let b = 0;
  for (const { re, w } of STACKING_RULE_PHRASES) {
    if (re.test(text)) b += w;
  }
  return Math.min(b, 0.38);
}

/**
 * Boost glossary-style lines like "Impaired An impaired creature…" for long terms from the question.
 */
export function glossaryAdjacentBoost(question: string, text: string): number {
  const terms = retrievalTermsFromQuestion(question).filter(
    (t) => t.length >= 6,
  );
  if (terms.length === 0) return 0;
  let b = 0;
  for (const term of terms) {
    const low = term.toLowerCase();
    const cap = term.charAt(0).toUpperCase() + term.slice(1).toLowerCase();
    const re = new RegExp(
      `\\b${escapeRegExp(cap)}\\s+An?\\s+${escapeRegExp(low)}\\b`,
      "i",
    );
    if (re.test(text)) b += 0.14;
  }
  return Math.min(b, 0.22);
}

/**
 * Lexical + rule-phrase score over one chunk's full surface (heading + body), for
 * full-corpus hybrid retrieval (not limited to the dense candidate pool).
 */
export function fullCorpusLexicalScore(
  question: string,
  queryTerms: string[],
  chunk: Chunk,
): number {
  const text = chunkTextWithHeading(chunk);
  let s = 0;
  if (queryTerms.length > 0) {
    s += lexicalMatchRatio(text, queryTerms) * 2;
    s += Math.min(countTermHitsInText(text, queryTerms) * 0.04, 0.45);
  }
  s += stackingRulePhraseBoost(question, text);
  s += glossaryAdjacentBoost(question, text);
  return s;
}

export function provenanceCitationScore(
  chunk: Chunk,
  question: string,
): number {
  const terms = retrievalTermsFromQuestion(question);
  const text = chunkTextWithHeading(chunk);
  if (terms.length === 0) return 0;
  return (
    lexicalMatchRatio(text, terms) * 2 +
    stackingRulePhraseBoost(question, text) +
    glossaryAdjacentBoost(question, text)
  );
}

/** Chunks to show when the model does not cite, ranked by lexical overlap with the question. */
export function filterChunksForProvenanceCitations(
  chunks: Chunk[],
  question: string,
  opts: { maxChunks: number; maxPerDocument?: number },
): Chunk[] {
  const terms = retrievalTermsFromQuestion(question);
  if (terms.length === 0 || chunks.length === 0) return [];

  const maxPerDoc = opts.maxPerDocument ?? 2;

  const scored = chunks.map((c, ord) => ({
    c,
    ord,
    hits: countTermHitsInText(chunkTextWithHeading(c), terms),
    score: provenanceCitationScore(c, question),
  }));

  const viable = scored.filter((s) => s.hits > 0 || s.score > 0);
  viable.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.hits !== a.hits) return b.hits - a.hits;
    return a.ord - b.ord;
  });

  const pickWithCap = (cap: number): Chunk[] => {
    const out: Chunk[] = [];
    const docCounts = new Map<string, number>();
    for (const s of viable) {
      if (out.length >= opts.maxChunks) break;
      const n = docCounts.get(s.c.documentId) ?? 0;
      if (n >= cap) continue;
      out.push(s.c);
      docCounts.set(s.c.documentId, n + 1);
    }
    return out;
  };

  const picked = pickWithCap(maxPerDoc);
  if (picked.length < opts.maxChunks) {
    const filled = pickWithCap(Number.POSITIVE_INFINITY);
    const seen = new Set(picked.map((p) => p.id));
    for (const c of filled) {
      if (picked.length >= opts.maxChunks) break;
      if (!seen.has(c.id)) {
        picked.push(c);
        seen.add(c.id);
      }
    }
  }
  return picked;
}
