export type LibraryGraphMeta = {
  version: number;
  enrichPromptVersion: number;
  zettelCount: number;
  edgeCount: number;
  mocCount: number;
  updatedAt?: string;
};

export type LibraryManifest = {
  id: string; // slug
  label: string;
  sourcePath: string; // absolute path to source folder or glob
  embeddingProvider: "ollama";
  embeddingModel: string; // e.g. "nomic-embed-text"
  embeddingDimensions: number; // e.g. 768
  chunkParams: { targetTokens: number; overlapTokens: number };
  graph?: LibraryGraphMeta;
  documents: Array<{
    id: string; // slug from filename
    label: string; // original filename
    sha256: string; // for skip-on-reingest
    pageCount: number;
    chunkRange: [number, number]; // inclusive indices into chunks.jsonl
  }>;
  createdAt: string;
  updatedAt: string;
};

export type Chunk = {
  id: string; // `${documentId}#${chunkIndex}`
  libraryId: string;
  documentId: string;
  chunkIndex: number;
  pageStart: number; // 1-based PDF page
  pageEnd: number;
  text: string;
  tokenCount: number;
  /** Detected section title for this span (heading-aware chunking); embedded & shown in prompts. */
  sectionHeading?: string;
};

export type Zettel = {
  id: string;
  libraryId: string;
  documentId: string;
  sectionIndex: number;
  title: string;
  pageStart: number;
  pageEnd: number;
  chunkIds: string[];
  synopsis: string;
  concepts: string[];
  definesConcepts: string[];
  referencesConcepts: string[];
  /** Cross-section headings proposed by enrichment (see_also edges) */
  seeAlsoTitles?: string[];
};

export type GraphEdgeType =
  | "defines"
  | "references"
  | "see_also"
  | "parent_section"
  | "prev_section"
  | "next_section";

export type GraphEdge = {
  src: string;
  dst: string;
  type: GraphEdgeType;
  concept?: string;
  weight: number;
};

export type DocumentMoc = {
  documentId: string;
  libraryId: string;
  label: string;
  scopeSummary: string;
  topConcepts: string[];
  authoritativeFor: string[];
};

export type Citation = {
  chunkId: string;
  documentLabel: string;
  pageHint: string; // e.g. "p. 42" or "pp. 42–43"
  snippet: string; // Hydrated server-side from chunk store; may be narrowed for display — never authored by the LLM
};

/** Per-chunk retrieval context sent to the LLM (order matches prompt excerpts). */
export type PromptChunkSummary = {
  order: number;
  chunkId: string;
  documentId: string;
  sectionHeading?: string;
  pageStart: number;
  pageEnd: number;
};

/** Populated when `retrieveDefineConceptWeight` > 0 and zettels define concepts matched the question. */
export type DefineConceptRetrieveDebug = {
  phraseCount: number;
  chunksSeeded: number;
  matchedPairs: string[];
};

/**
 * Returned on every query so server logs and browser devtools can trace citation mismatches:
 * wrong model cites vs empty cites + provenance fallback, etc.
 */
export type AttributionDebug = {
  promptChunkSummaries: PromptChunkSummary[];
  modelCitedChunkIds: string[];
  /** Model-cited IDs that matched the corpus (possibly via near-doc-id fix); includes cites later dropped because they were not in `chunksInPrompt`. Prefer `finalCitationChunkIds` for “what shipped.” */
  resolvedCitationIds: string[];
  unresolvedModelChunkIds: string[];
  usedProvenanceFallback: boolean;
  fallbackCitationIds: string[];
  /** When the model cites only a glossary but the answer implies multi-instance rules; we add the first prompt chunk that contains that wording. */
  stackingCitationSupplementIds: string[];
  /** Stacking questions: citations removed for having neither rule phrases nor question terms (e.g. Objects chunk). */
  prunedIrrelevantCitationIds: string[];
  /** Overlap score between **final answer** and each excerpt (re-ranking / pruning; never adds sources). */
  answerCitationAlignmentScores: Record<string, number>;
  /** Cites dropped after alignment vs the answer and/or weaker question-word overlap vs sibling cites (never adds sources). */
  weakSupportPrunedCitationIds: string[];
  /**
   * Model cites that had **zero** substantive question-token hits on their snippets; citations were rebuilt
   * from prompt excerpts that do overlap (`filterChunksForProvenanceCitations`). Values are dropped chunk ids.
   */
  questionOverlapCitationReplacementIds?: string[];
  /** Model cites whose canonical chunk IDs were absent from excerpts in **this** prompt (`chunksInPrompt`); dropped — answers must not cite unseen text. */
  promptContextDroppedCitationIds?: string[];
  /** Chunk IDs in `QueryResult.citations` after provenance fallback, overlap replacement, stacking supplement, pruning, and alignment (`citations[].chunkId`). Use this for ops logs—not `resolvedCitationIds` alone. */
  finalCitationChunkIds: string[];
  /** When exactly one citation: overlap of question terms with that excerpt (telemetry only). */
  singleCitationQueryGrounding?: {
    lexicalMatchRatioToQuestion: number;
    queryTermWholeWordHits: number;
  };
  /** Last retrieve: zettel definesConcept seeding (omitted if weight was 0). */
  defineConceptRetrieveDebug?: DefineConceptRetrieveDebug;
};

export type QueryResult = {
  libraryId: string;
  answer: string;
  spokenSummary?: string; // For Web Speech TTS
  confidence: "high" | "mixed" | "not_in_book" | "speculative";
  citations: Citation[];
  traces?: {
    // Latency breakdown (F11)
    embedMs: number;
    retrieveMs: number;
    generateMs: number;
  };
  /** Debug-only provenance pipeline; safe to ignore in UI. */
  attributionDebug?: AttributionDebug;
};
