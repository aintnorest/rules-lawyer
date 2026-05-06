import { config } from "../config";
import { JsonVectorStore } from "../ingest/store";
import { chunkTextWithHeading } from "../lib/chunk-text";
import type {
  AttributionDebug,
  Chunk,
  Citation,
  DefineConceptRetrieveDebug,
  QueryResult,
} from "../types";
import { alignCitationsToAnswer } from "./citation-alignment";
import { focusCitationSnippetForDisplay } from "./citation-snippet";
import { type GeneratedAnswer, normalizeModelChunkId } from "./generate";
import {
  answerMentionsMultiInstanceMechanics,
  countTermHitsInText,
  excerptContainsStackingRuleText,
  filterChunksForProvenanceCitations,
  lexicalMatchRatio,
  questionMentionsStackingOrDuplicates,
  retrievalTermsFromQuestion,
  snippetSupportsStackingQuery,
} from "./retrieval";

const CITATION_SNIPPET_MAX = 900;

const CHUNK_ID_RE = /^(.+)#(\d+)$/;

/** Small Levenshtein for typo-tolerant CHUNK_ID ↔ context chunk matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1);
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * When the model omits a letter in the document slug (e.g. `ocult-...` vs `occult-...`),
 * map to the canonical id if the same trailing `#n` appears in prompt context.
 */
function resolveNearChunkId(
  requestedId: string,
  contextChunks: Chunk[],
): string | undefined {
  const m = requestedId.match(CHUNK_ID_RE);
  if (!m || contextChunks.length === 0) return undefined;
  const docPart = m[1];
  const indexStr = m[2];
  const maxEdits = 4;
  let best: { id: string; d: number } | undefined;
  for (const ch of contextChunks) {
    const cm = ch.id.match(CHUNK_ID_RE);
    if (!cm || cm[2] !== indexStr) continue;
    const d = levenshtein(docPart.toLowerCase(), cm[1].toLowerCase());
    if (d < 1 || d > maxEdits) continue;
    if (!best || d < best.d) best = { id: ch.id, d };
  }
  return best?.id;
}

function citationFromChunk(chunk: Chunk, truncateSnippet: boolean): Citation {
  const body = chunkTextWithHeading(chunk);
  const snippet =
    truncateSnippet && body.length > CITATION_SNIPPET_MAX
      ? `${body.slice(0, CITATION_SNIPPET_MAX)}…`
      : body;
  return {
    chunkId: chunk.id,
    documentLabel: chunk.documentId,
    pageHint:
      chunk.pageStart === chunk.pageEnd
        ? `p. ${chunk.pageStart}`
        : `pp. ${chunk.pageStart}-${chunk.pageEnd}`,
    snippet,
  };
}

export async function formatResult(
  libraryId: string,
  output: GeneratedAnswer,
  traces: QueryResult["traces"],
  contextChunks?: Chunk[],
  question?: string,
  defineConceptRetrieveDebug?: DefineConceptRetrieveDebug | null,
): Promise<QueryResult> {
  const store = new JsonVectorStore(config.dataDir, libraryId);
  await store.load();

  const promptChunkSummaries: AttributionDebug["promptChunkSummaries"] = (
    contextChunks ?? []
  ).map((c, order) => ({
    order,
    chunkId: c.id,
    documentId: c.documentId,
    sectionHeading: c.sectionHeading,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
  }));

  const modelCitedChunkIds = [...output.citedChunkIds];
  const resolvedFromModel = new Set<string>();
  let citations: Citation[] = [];
  let usedProvenanceFallback = false;

  for (const chunkId of output.citedChunkIds
    .map(normalizeModelChunkId)
    .filter(Boolean)) {
    let chunk = await store.getChunkById(chunkId);
    if (!chunk && contextChunks?.length) {
      const alt = resolveNearChunkId(chunkId, contextChunks);
      if (alt) chunk = await store.getChunkById(alt);
    }
    if (chunk) {
      resolvedFromModel.add(chunkId);
      citations.push(citationFromChunk(chunk, false));
    }
  }

  let promptContextDroppedCitationIds: string[] | undefined;
  const promptChunkIdSet = contextChunks?.length
    ? new Set(contextChunks.map((c) => c.id))
    : null;
  if (promptChunkIdSet) {
    const dropped = citations
      .filter((c) => !promptChunkIdSet.has(c.chunkId))
      .map((c) => c.chunkId);
    if (dropped.length > 0) {
      promptContextDroppedCitationIds = dropped;
      citations = citations.filter((c) => promptChunkIdSet.has(c.chunkId));
    }
  }

  let questionOverlapCitationReplacementIds: string[] | undefined;

  if (
    citations.length > 0 &&
    question?.trim() &&
    contextChunks?.length &&
    !usedProvenanceFallback
  ) {
    const terms = retrievalTermsFromQuestion(question);
    if (terms.length >= 3) {
      const allZero = citations.every(
        (c) => countTermHitsInText(c.snippet, terms) === 0,
      );
      if (allZero) {
        const better = filterChunksForProvenanceCitations(
          contextChunks,
          question,
          {
            maxChunks: Math.max(citations.length, 3),
            maxPerDocument: config.retrieveProvenanceMaxPerDocument,
          },
        );
        const hasOverlap = better.some(
          (ch) => countTermHitsInText(chunkTextWithHeading(ch), terms) > 0,
        );
        if (hasOverlap && better.length > 0) {
          questionOverlapCitationReplacementIds = citations.map(
            (c) => c.chunkId,
          );
          citations = better.map((ch) => citationFromChunk(ch, true));
        }
      }
    }
  }

  const unresolvedModelChunkIds = [
    ...new Set(
      output.citedChunkIds
        .map(normalizeModelChunkId)
        .filter(Boolean)
        .filter((id) => !resolvedFromModel.has(id)),
    ),
  ];

  const fallbackCitationIds: string[] = [];

  if (citations.length === 0 && contextChunks?.length && question?.trim()) {
    usedProvenanceFallback = true;
    const fallback = filterChunksForProvenanceCitations(
      contextChunks,
      question,
      {
        maxChunks: 5,
        maxPerDocument: config.retrieveProvenanceMaxPerDocument,
      },
    );
    for (const chunk of fallback) {
      fallbackCitationIds.push(chunk.id);
      citations.push(citationFromChunk(chunk, true));
    }
  }

  const stackingCitationSupplementIds: string[] = [];

  if (
    contextChunks?.length &&
    question?.trim() &&
    citations.length > 0 &&
    questionMentionsStackingOrDuplicates(question) &&
    answerMentionsMultiInstanceMechanics(output.answer) &&
    !citations.some((cit) => excerptContainsStackingRuleText(cit.snippet))
  ) {
    const citedIds = new Set(citations.map((c) => c.chunkId));
    for (const chunk of contextChunks) {
      if (citedIds.has(chunk.id)) continue;
      const surface = chunkTextWithHeading(chunk);
      if (!excerptContainsStackingRuleText(surface)) continue;
      stackingCitationSupplementIds.push(chunk.id);
      citations.push(citationFromChunk(chunk, false));
      break;
    }
  }

  let prunedIrrelevantCitationIds: string[] = [];

  if (
    question?.trim() &&
    questionMentionsStackingOrDuplicates(question) &&
    citations.length > 0
  ) {
    const filtered = citations.filter((c) =>
      snippetSupportsStackingQuery(question, c.snippet),
    );
    if (filtered.length > 0) {
      const kept = new Set(filtered.map((c) => c.chunkId));
      prunedIrrelevantCitationIds = citations
        .filter((c) => !kept.has(c.chunkId))
        .map((c) => c.chunkId);
      citations = filtered;
    }
  }

  let answerCitationAlignmentScores: Record<string, number> = {};
  let weakSupportPrunedCitationIds: string[] = [];

  if (output.answer.trim() && citations.length > 0) {
    const aligned = alignCitationsToAnswer(output.answer, citations, {
      question,
    });
    citations = aligned.citations;
    answerCitationAlignmentScores = aligned.scoresByChunkId;
    weakSupportPrunedCitationIds = aligned.weakSupportPrunedIds;
    citations = citations.map((c) => ({
      ...c,
      snippet: focusCitationSnippetForDisplay(c.snippet, output.answer),
    }));
  }

  let singleCitationQueryGrounding: AttributionDebug["singleCitationQueryGrounding"];
  if (question?.trim() && citations.length === 1) {
    const terms = retrievalTermsFromQuestion(question);
    const snippet = citations[0]?.snippet ?? "";
    singleCitationQueryGrounding = {
      lexicalMatchRatioToQuestion: lexicalMatchRatio(snippet, terms),
      queryTermWholeWordHits: countTermHitsInText(snippet, terms),
    };
  }

  const attributionDebug: AttributionDebug = {
    promptChunkSummaries,
    modelCitedChunkIds,
    resolvedCitationIds: [...resolvedFromModel],
    unresolvedModelChunkIds,
    usedProvenanceFallback,
    fallbackCitationIds,
    stackingCitationSupplementIds,
    prunedIrrelevantCitationIds,
    answerCitationAlignmentScores,
    weakSupportPrunedCitationIds,
    finalCitationChunkIds: citations.map((c) => c.chunkId),
    ...(singleCitationQueryGrounding !== undefined && {
      singleCitationQueryGrounding,
    }),
    ...(defineConceptRetrieveDebug && {
      defineConceptRetrieveDebug,
    }),
    ...(questionOverlapCitationReplacementIds?.length && {
      questionOverlapCitationReplacementIds,
    }),
    ...(promptContextDroppedCitationIds?.length && {
      promptContextDroppedCitationIds,
    }),
  };

  let confidence = output.confidence;
  if (questionOverlapCitationReplacementIds?.length && confidence === "high") {
    confidence = "mixed";
  }
  if (promptContextDroppedCitationIds?.length && confidence === "high") {
    confidence = "mixed";
  }

  return {
    libraryId,
    answer: output.answer,
    spokenSummary: output.spokenSummary,
    confidence,
    citations,
    traces,
    attributionDebug,
  };
}
