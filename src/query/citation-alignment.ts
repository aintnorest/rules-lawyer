import {
  excerptContainsStackingRuleText,
  lexicalMatchRatio,
  questionMentionsStackingOrDuplicates,
  retrievalTermsFromQuestion,
} from "./retrieval";

const ALIGNMENT_STOP = new Set([
  "that",
  "this",
  "with",
  "from",
  "your",
  "have",
  "has",
  "will",
  "when",
  "what",
  "there",
  "they",
  "them",
  "must",
  "gain",
  "rule",
  "rules",
  "book",
  "text",
  "states",
  "state",
  "relevant",
  "excerpt",
  "excerpts",
  "provided",
  "answer",
  "question",
  "does",
  "any",
  "also",
  "into",
  "about",
  "such",
  "than",
  "then",
  "usually",
]);

/**
 * Tokens from the final answer worth matching against excerpts (overlap = support).
 */
export function extractAlignmentTermsFromAnswer(answer: string): string[] {
  const raw = answer.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return [
    ...new Set(
      raw
        .map((w) => w.replace(/^'+|'+$/g, ""))
        .filter((w) => w.length >= 4 && !ALIGNMENT_STOP.has(w)),
    ),
  ];
}

/** Lexical overlap + rule-phrase overlap + coarse bigram overlap; does not judge truthfulness. */
export function scoreAnswerCitationSupport(
  answer: string,
  snippet: string,
): number {
  const terms = extractAlignmentTermsFromAnswer(answer);
  const lowA = answer.toLowerCase();
  const lowS = snippet.toLowerCase();
  let score = terms.length > 0 ? lexicalMatchRatio(snippet, terms) * 6 : 0;

  if (
    excerptContainsStackingRuleText(answer) &&
    excerptContainsStackingRuleText(snippet)
  ) {
    score += 4;
  }

  const words = lowA.match(/[a-z0-9']+/g) ?? [];
  let bigramBonus = 0;
  for (let i = 0; i < words.length - 1; i++) {
    const bi = `${words[i]} ${words[i + 1]}`;
    if (bi.length < 8) continue;
    if (lowS.includes(bi)) bigramBonus += 1.1;
  }
  score += Math.min(bigramBonus, 4);
  return score;
}

/**
 * Highest clause-level support (so one misleading introductory sentence doesn't
 * prop up unrelated excerpts when a later clause quotes the rule text).
 */
export function scoreAnswerSupportBestClause(
  answer: string,
  snippet: string,
): number {
  const clauses = answer
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 28);
  const parts = clauses.length ? clauses : [answer];
  let best = 0;
  for (const p of parts) {
    best = Math.max(best, scoreAnswerCitationSupport(p, snippet));
  }
  return best;
}

const MIN_MAX_ALIGNMENT_TO_PRUNE = 1.35;
/** Keep cite if score >= maxScore * REL; only when strongest cite is clearly substantive. */
const ALIGNMENT_RELATIVE_KEEP_FLOOR = 0.42;
/** Minimum best-in-set question lexical match (fraction of mined terms) to apply relative pruning for non-stacking questions. */
const MIN_MAX_QUESTION_LEXICAL_TO_PRUNE = 0.12;
/** Keep cite if question-lex score >= maxQ * REL (non-stacking only). */
const QUESTION_LEX_RELATIVE_KEEP = 0.38;

/**
 * Re-rank by overlap between the **final answer** and each excerpt already in the cite list.
 * Optionally drops cites scoring far below the best in that set (never adds new sources).
 */
export function alignCitationsToAnswer<
  T extends { chunkId: string; snippet: string },
>(
  answer: string,
  citations: T[],
  options?: {
    /** When set, cites far below strongest question-term overlap among the citation set may be dropped (multi-citation). */
    question?: string;
  },
): {
  citations: T[];
  scoresByChunkId: Record<string, number>;
  weakSupportPrunedIds: string[];
} {
  if (citations.length === 0) {
    return { citations, scoresByChunkId: {}, weakSupportPrunedIds: [] };
  }
  const only = citations[0];
  if (citations.length === 1 && only) {
    return {
      citations,
      scoresByChunkId: {
        [only.chunkId]: scoreAnswerSupportBestClause(answer, only.snippet),
      },
      weakSupportPrunedIds: [],
    };
  }

  const scored = citations.map((c) => ({
    c,
    score: scoreAnswerSupportBestClause(answer, c.snippet),
  }));
  const scoresByChunkId = Object.fromEntries(
    scored.map(({ c, score }) => [c.chunkId, score]),
  );
  const maxScore = Math.max(...scored.map((s) => s.score), 1e-9);

  let kept = scored;
  if (maxScore >= MIN_MAX_ALIGNMENT_TO_PRUNE) {
    const filtered = scored.filter(
      (x) => x.score >= maxScore * ALIGNMENT_RELATIVE_KEEP_FLOOR,
    );
    if (filtered.length >= 1) kept = filtered;
  }

  const qTrimmed = options?.question?.trim();
  if (
    qTrimmed &&
    kept.length >= 2 &&
    !questionMentionsStackingOrDuplicates(qTrimmed)
  ) {
    const terms = retrievalTermsFromQuestion(qTrimmed);
    if (terms.length >= 2) {
      const qScored = kept.map(({ c, score }) => ({
        c,
        score,
        qLex: lexicalMatchRatio(c.snippet, terms),
      }));
      const maxQ = Math.max(...qScored.map((z) => z.qLex));
      if (maxQ >= MIN_MAX_QUESTION_LEXICAL_TO_PRUNE) {
        const filtered = qScored.filter(
          ({ qLex }) => qLex >= maxQ * QUESTION_LEX_RELATIVE_KEEP,
        );
        if (filtered.length >= 1) kept = filtered;
      }
    }
  }

  kept = [...kept].sort((a, b) => b.score - a.score);
  const keptIds = new Set(kept.map((k) => k.c.chunkId));
  const weakSupportPrunedIds = citations
    .filter((c) => !keptIds.has(c.chunkId))
    .map((c) => c.chunkId);

  return {
    citations: kept.map((k) => k.c),
    scoresByChunkId,
    weakSupportPrunedIds,
  };
}
