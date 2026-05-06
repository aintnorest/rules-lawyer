import fs from "node:fs/promises";
import path from "node:path";
import { chunkTextWithHeading } from "../lib/chunk-text";
import { normalizeConcept, retrievalConceptOverlaps } from "../lib/concepts";
import { cosineSimilarity } from "../lib/similarity";
import { graphNeighborChunkBoosts } from "../query/graph-expand";
import {
  conceptQueryPhrases,
  fullCorpusLexicalScore,
  glossaryAdjacentBoost,
  lexicalMatchRatio,
  stackingRulePhraseBoost,
} from "../query/retrieval";
import { documentRouterBoostMap } from "../query/router";
import type {
  Chunk,
  DefineConceptRetrieveDebug,
  DocumentMoc,
  GraphEdge,
  GraphEdgeType,
  LibraryManifest,
  Zettel,
} from "../types";
import { indexHintBoostForChunk, parseIndexHintsJson } from "./index-hints";

export type RetrieveAugmentOptions = {
  question?: string;
  queryTerms?: string[];
  candidatePool?: number;
  lexicalWeight?: number;
  neighborExpandForTop?: number;
  maxChunksPerDocument?: number;
  indexHintWeight?: number;
  hybridLexicalTopK?: number;
  /** Per-document soft boost from MOC router. */
  documentBoost?: Map<string, number>;
  graphSeedCount?: number;
  graphExpandPerSeed?: number;
  graphExpandWeight?: number;
  graphEdgeTypes?: GraphEdgeType[];
  /**
   * Additive retrieval: union chunks whose zettel **definesConcepts** overlap question phrases (`conceptQueryPhrases`),
   * and add this weight × match count (capped) in merged rerank. **0 disables** — default in config preserves prior behavior.
   */
  defineConceptBoostWeight?: number;
  /** Max chunk indices to seed from definesConcept matching per query (after sorting by hits). */
  defineConceptMaxChunks?: number;
};

export class JsonVectorStore {
  private libraryDir: string;
  private chunks: Chunk[] = [];
  private vectors: Float32Array[] = [];
  private indexHintsByDocument: Record<
    string,
    Record<string, number[]>
  > | null = null;

  private zettels: Zettel[] = [];
  private edges: GraphEdge[] = [];
  private mocs: DocumentMoc[] = [];
  private zettelVectors: Float32Array[] = [];
  private mocVectors: Float32Array[] = [];
  private mocDocumentIds: string[] = [];
  private chunkIdToZettelId = new Map<string, string>();
  private chunkIndexById = new Map<string, number>();
  /** normalized definesConcept keys → pooled chunk indices (enriched zettels). */
  private definesConceptChunkLookup = new Map<string, Set<number>>();
  /** Cleared each `retrieveWithNeighbors`; set when definesConcept boosting runs. */
  private defineConceptRetrieveDebug: DefineConceptRetrieveDebug | null = null;

  constructor(
    dataDir: string,
    private libraryId: string,
  ) {
    this.libraryDir = path.join(dataDir, libraryId);
  }

  documentRouterBoosts(
    queryVec: number[],
    weight: number,
  ): Map<string, number> {
    return documentRouterBoostMap(
      queryVec,
      this.mocVectors,
      this.mocDocumentIds,
      weight,
    );
  }

  async init() {
    await fs.mkdir(this.libraryDir, { recursive: true });
  }

  async saveManifest(manifest: LibraryManifest) {
    await fs.writeFile(
      path.join(this.libraryDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
  }

  async loadManifest(): Promise<LibraryManifest | null> {
    try {
      const data = await fs.readFile(
        path.join(this.libraryDir, "manifest.json"),
        "utf8",
      );
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async saveChunks(chunks: Chunk[], vectors: number[][]) {
    const chunkLines = chunks.map((c) => JSON.stringify(c)).join("\n");
    await fs.writeFile(path.join(this.libraryDir, "chunks.jsonl"), chunkLines);

    if (vectors.length > 0) {
      const dimensions = vectors[0]?.length || 0;
      const floatArray = new Float32Array(vectors.length * dimensions);
      for (let i = 0; i < vectors.length; i++) {
        floatArray.set(vectors[i], i * dimensions);
      }
      await fs.writeFile(
        path.join(this.libraryDir, "vectors.bin"),
        Buffer.from(floatArray.buffer),
      );
    }
  }

  async saveZettels(zettels: Zettel[], vectors: number[][]) {
    await fs.writeFile(
      path.join(this.libraryDir, "zettels.jsonl"),
      zettels.map((z) => JSON.stringify(z)).join("\n"),
      "utf8",
    );
    if (vectors.length > 0) {
      const dimensions = vectors[0]?.length || 0;
      const floatArray = new Float32Array(vectors.length * dimensions);
      for (let i = 0; i < vectors.length; i++) {
        const row = vectors[i];
        if (!row) continue;
        floatArray.set(row, i * dimensions);
      }
      await fs.writeFile(
        path.join(this.libraryDir, "zettel_vectors.bin"),
        Buffer.from(floatArray.buffer),
      );
    }
  }

  async saveEdges(edges: GraphEdge[]) {
    await fs.writeFile(
      path.join(this.libraryDir, "edges.jsonl"),
      edges.map((e) => JSON.stringify(e)).join("\n"),
      "utf8",
    );
  }

  async saveMocs(mocs: DocumentMoc[], vectors: number[][]) {
    await fs.writeFile(
      path.join(this.libraryDir, "moc.jsonl"),
      mocs.map((m) => JSON.stringify(m)).join("\n"),
      "utf8",
    );
    if (vectors.length > 0 && mocs.length === vectors.length) {
      const dimensions = vectors[0]?.length || 0;
      const floatArray = new Float32Array(vectors.length * dimensions);
      for (let i = 0; i < vectors.length; i++) {
        const row = vectors[i];
        if (!row) continue;
        floatArray.set(row, i * dimensions);
      }
      await fs.writeFile(
        path.join(this.libraryDir, "moc_vectors.bin"),
        Buffer.from(floatArray.buffer),
      );
    }
  }

  private rebuildChunkToZettel() {
    this.chunkIdToZettelId.clear();
    for (const z of this.zettels) {
      for (const cid of z.chunkIds) this.chunkIdToZettelId.set(cid, z.id);
    }
  }

  private rebuildChunkIndexById(): void {
    this.chunkIndexById.clear();
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (c) this.chunkIndexById.set(c.id, i);
    }
  }

  private rebuildDefinesConceptChunkLookup(): void {
    this.definesConceptChunkLookup.clear();
    if (this.zettels.length === 0) return;
    for (const z of this.zettels) {
      for (const raw of z.definesConcepts) {
        const key = normalizeConcept(raw);
        if (key.length < 3) continue;
        let set = this.definesConceptChunkLookup.get(key);
        if (!set) {
          set = new Set();
          this.definesConceptChunkLookup.set(key, set);
        }
        for (const cid of z.chunkIds) {
          const ix = this.chunkIndexById.get(cid);
          if (ix !== undefined) set.add(ix);
        }
      }
    }
  }

  /** Last `retrieveWithNeighbors` define-concept summary; null if boosting was off or no matches. */
  getDefineConceptRetrieveDebug(): DefineConceptRetrieveDebug | null {
    return this.defineConceptRetrieveDebug;
  }

  private async loadGraphArtifacts() {
    this.zettels = [];
    this.edges = [];
    this.mocs = [];
    this.zettelVectors = [];
    this.mocVectors = [];
    this.mocDocumentIds = [];
    this.chunkIdToZettelId.clear();

    try {
      const zTxt = await fs.readFile(
        path.join(this.libraryDir, "zettels.jsonl"),
        "utf8",
      );
      this.zettels = zTxt
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Zettel);
    } catch {
      this.rebuildChunkToZettel();
      this.rebuildDefinesConceptChunkLookup();
      return;
    }

    try {
      const zb = await fs.readFile(
        path.join(this.libraryDir, "zettel_vectors.bin"),
      );
      const floatArray = new Float32Array(
        zb.buffer,
        zb.byteOffset,
        zb.byteLength / 4,
      );
      if (this.zettels.length === 0) {
        this.rebuildChunkToZettel();
        this.rebuildDefinesConceptChunkLookup();
        return;
      }
      const dimensions = floatArray.length / this.zettels.length;
      this.zettelVectors = [];
      for (let i = 0; i < this.zettels.length; i++) {
        this.zettelVectors.push(
          floatArray.slice(i * dimensions, (i + 1) * dimensions),
        );
      }
    } catch {
      /* optional */
    }

    try {
      const eTxt = await fs.readFile(
        path.join(this.libraryDir, "edges.jsonl"),
        "utf8",
      );
      this.edges = eTxt
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as GraphEdge);
    } catch {
      /* ok */
    }

    try {
      const mTxt = await fs.readFile(
        path.join(this.libraryDir, "moc.jsonl"),
        "utf8",
      );
      this.mocs = mTxt
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as DocumentMoc);
    } catch {
      /* ok */
    }

    try {
      const mb = await fs.readFile(
        path.join(this.libraryDir, "moc_vectors.bin"),
      );
      const floatArray = new Float32Array(
        mb.buffer,
        mb.byteOffset,
        mb.byteLength / 4,
      );
      if (this.mocs.length > 0) {
        const dimensions = floatArray.length / this.mocs.length;
        this.mocVectors = [];
        this.mocDocumentIds = [];
        for (let i = 0; i < this.mocs.length; i++) {
          this.mocVectors.push(
            floatArray.slice(i * dimensions, (i + 1) * dimensions),
          );
          const m = this.mocs[i];
          if (m) this.mocDocumentIds.push(m.documentId);
        }
      }
    } catch {
      /* ok */
    }

    this.rebuildChunkToZettel();
    this.rebuildDefinesConceptChunkLookup();
  }

  async load() {
    try {
      const chunkData = await fs.readFile(
        path.join(this.libraryDir, "chunks.jsonl"),
        "utf8",
      );
      this.chunks = chunkData
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));

      const vectorBuffer = await fs.readFile(
        path.join(this.libraryDir, "vectors.bin"),
      );
      const floatArray = new Float32Array(
        vectorBuffer.buffer,
        vectorBuffer.byteOffset,
        vectorBuffer.byteLength / 4,
      );
      const dimensions = floatArray.length / this.chunks.length;

      this.vectors = [];
      for (let i = 0; i < this.chunks.length; i++) {
        this.vectors.push(
          floatArray.slice(i * dimensions, (i + 1) * dimensions),
        );
      }
      this.rebuildChunkIndexById();
      await this.loadGraphArtifacts();
    } catch {
      console.warn("Could not load chunks/vectors for library", this.libraryId);
      this.chunks = [];
      this.vectors = [];
      this.chunkIndexById.clear();
      this.definesConceptChunkLookup.clear();
    }

    try {
      const hintPath = path.join(this.libraryDir, "index-hints.json");
      const raw = await fs.readFile(hintPath, "utf8");
      this.indexHintsByDocument = parseIndexHintsJson(raw);
    } catch {
      this.indexHintsByDocument = null;
    }
  }

  async retrieve(queryVector: number[], topK: number = 5): Promise<Chunk[]> {
    if (this.vectors.length === 0) await this.load();

    const scores = this.vectors.map((vec, i) => ({
      index: i,
      score: cosineSimilarity(queryVector, vec),
    }));

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK).map((s) => this.chunks[s.index]);
  }

  /**
   * Dense pool ∪ full-corpus lexical top-K → optional lexical rerank on that merged pool → top-K primary
   * → neighbor expansion only for the first `neighborExpandForTop` primaries (±neighborWindow within the same document).
   */
  async retrieveWithNeighbors(
    queryVector: number[],
    topK: number,
    neighborWindow: number,
    options: RetrieveAugmentOptions = {},
  ): Promise<Chunk[]> {
    const {
      question: questionRaw = "",
      queryTerms = [],
      candidatePool = 48,
      lexicalWeight = 0.18,
      neighborExpandForTop = 3,
      maxChunksPerDocument = 3,
      indexHintWeight = 0,
      hybridLexicalTopK = 0,
      documentBoost = undefined,
      graphSeedCount = 24,
      graphExpandPerSeed = 3,
      graphExpandWeight = 0,
      graphEdgeTypes = ["defines", "references", "see_also"] as GraphEdgeType[],
      defineConceptBoostWeight = 0,
      defineConceptMaxChunks = 12,
    } = options;
    const question = questionRaw.trim();

    this.defineConceptRetrieveDebug = null;

    if (this.vectors.length === 0) await this.load();

    const denseSorted = this.vectors
      .map((vec, i) => ({
        index: i,
        score: cosineSimilarity(queryVector, vec),
      }))
      .sort((a, b) => b.score - a.score);

    const denseScoreByIndex = new Map<number, number>();
    for (const d of denseSorted) denseScoreByIndex.set(d.index, d.score);

    const poolSize = Math.min(
      Math.max(candidatePool, topK),
      denseSorted.length,
    );

    const poolIndexSet = new Set<number>();
    for (let i = 0; i < poolSize; i++) {
      poolIndexSet.add(denseSorted[i].index);
    }

    if (
      hybridLexicalTopK > 0 &&
      question.length > 0 &&
      this.chunks.length > 0
    ) {
      const lexScored = this.chunks.map((chunk, index) => ({
        index,
        lex: fullCorpusLexicalScore(question, queryTerms, chunk),
      }));
      lexScored.sort((a, b) => b.lex - a.lex);
      let taken = 0;
      for (const row of lexScored) {
        if (taken >= hybridLexicalTopK) break;
        if (row.lex <= 0) break;
        poolIndexSet.add(row.index);
        taken++;
      }
    }

    let graphChunkBoost = new Map<number, number>();
    if (
      graphExpandWeight > 0 &&
      this.zettels.length > 0 &&
      this.edges.length > 0 &&
      denseSorted.length > 0
    ) {
      const nSeeds = Math.min(graphSeedCount, denseSorted.length);
      const seedChunkIds = denseSorted.slice(0, nSeeds).flatMap((d) => {
        const id = this.chunks[d.index]?.id;
        return id ? [id] : [];
      });
      graphChunkBoost = graphNeighborChunkBoosts({
        seedChunkIds,
        chunks: this.chunks,
        zettels: this.zettels,
        edges: this.edges,
        chunkIdToZettelId: this.chunkIdToZettelId,
        allowedTypes: new Set(graphEdgeTypes),
        expandPerSeed: graphExpandPerSeed,
        baseWeight: graphExpandWeight,
      });
      for (const idx of graphChunkBoost.keys()) poolIndexSet.add(idx);
    }

    let defineConceptChunkBoost = new Map<number, number>();
    if (
      defineConceptBoostWeight > 0 &&
      question.length > 0 &&
      this.definesConceptChunkLookup.size > 0 &&
      this.chunks.length > 0
    ) {
      const phraseNorms = conceptQueryPhrases(question);
      const chunkHits = new Map<number, number>();
      const matchedPairSet = new Set<string>();
      const maxPairs = 48;

      for (const phrase of phraseNorms) {
        for (const [defKey, idxSet] of this.definesConceptChunkLookup) {
          if (!retrievalConceptOverlaps(defKey, phrase)) continue;
          for (const idx of idxSet) {
            chunkHits.set(idx, (chunkHits.get(idx) ?? 0) + 1);
          }
          if (matchedPairSet.size < maxPairs) {
            matchedPairSet.add(`${phrase}↔${defKey}`);
          }
        }
      }

      const sortedSeeds = [...chunkHits.entries()].sort((a, b) => b[1] - a[1]);
      const seeds = sortedSeeds.slice(0, defineConceptMaxChunks);
      /** Cap how many phrase↔concept hits contribute to rerank (keeps boost small). */
      const hitCap = 4;
      defineConceptChunkBoost = new Map(
        seeds.map(([idx, hits]) => [
          idx,
          defineConceptBoostWeight * Math.min(hits, hitCap),
        ]),
      );
      for (const [idx] of seeds) poolIndexSet.add(idx);

      this.defineConceptRetrieveDebug = {
        phraseCount: phraseNorms.length,
        chunksSeeded: seeds.length,
        matchedPairs: [...matchedPairSet],
      };
    }

    const mergedPoolIndices = [...poolIndexSet];

    const ranked = mergedPoolIndices.flatMap((index) => {
      const chunk = this.chunks[index];
      if (!chunk) return [];
      const denseScore = denseScoreByIndex.get(index) ?? 0;
      let s =
        denseScore +
        (documentBoost?.get(chunk.documentId) ?? 0) +
        (graphChunkBoost.get(index) ?? 0) +
        (defineConceptChunkBoost.get(index) ?? 0);
      const surface = chunkTextWithHeading(chunk);
      if (queryTerms.length > 0 && lexicalWeight > 0) {
        s += lexicalWeight * lexicalMatchRatio(surface, queryTerms);
      }
      if (question) {
        s += stackingRulePhraseBoost(question, surface);
        s += glossaryAdjacentBoost(question, surface);
      }
      if (queryTerms.length > 0 && indexHintWeight > 0) {
        s += indexHintBoostForChunk(
          chunk,
          queryTerms,
          this.indexHintsByDocument,
          indexHintWeight,
        );
      }
      return [{ index, score: s }];
    });
    ranked.sort((a, b) => b.score - a.score);

    const primary: Chunk[] = [];
    const seen = new Set<string>();
    const docCounts = new Map<string, number>();

    for (const r of ranked) {
      if (primary.length >= topK) break;
      const c = this.chunks[r.index];
      if (!c || seen.has(c.id)) continue;
      const dc = docCounts.get(c.documentId) ?? 0;
      if (dc >= maxChunksPerDocument) continue;
      primary.push(c);
      seen.add(c.id);
      docCounts.set(c.documentId, dc + 1);
    }

    if (primary.length < topK) {
      for (const r of ranked) {
        if (primary.length >= topK) break;
        const c = this.chunks[r.index];
        if (!c || seen.has(c.id)) continue;
        primary.push(c);
        seen.add(c.id);
      }
    }

    if (neighborWindow <= 0) {
      return primary;
    }

    const byDocIndex = new Map<string, Chunk>();
    for (const c of this.chunks) {
      byDocIndex.set(`${c.documentId}\t${c.chunkIndex}`, c);
    }

    const expandFor = Math.min(neighborExpandForTop, primary.length);
    const out: Chunk[] = [];
    const expandedSeen = new Set<string>();

    for (let i = 0; i < primary.length; i++) {
      const c = primary[i];
      if (!expandedSeen.has(c.id)) {
        out.push(c);
        expandedSeen.add(c.id);
      }
      if (i >= expandFor) continue;

      for (let d = -neighborWindow; d <= neighborWindow; d++) {
        if (d === 0) continue;
        const idx = c.chunkIndex + d;
        if (idx < 0) continue;
        const neighbor = byDocIndex.get(`${c.documentId}\t${idx}`);
        if (neighbor && !expandedSeen.has(neighbor.id)) {
          out.push(neighbor);
          expandedSeen.add(neighbor.id);
        }
      }
    }

    return out;
  }

  async getChunkById(chunkId: string): Promise<Chunk | undefined> {
    if (this.chunks.length === 0) await this.load();
    return this.chunks.find((c) => c.id === chunkId);
  }

  /** Write ingest-generated index map; overwrites prior file. */
  async saveIndexHints(
    byDocument: Record<string, Record<string, number[]>>,
  ): Promise<void> {
    const payload = {
      version: 1,
      generatedAt: new Date().toISOString(),
      byDocument,
    };
    await fs.writeFile(
      path.join(this.libraryDir, "index-hints.json"),
      JSON.stringify(payload, null, 2),
      "utf8",
    );
    this.indexHintsByDocument = byDocument;
  }

  /** Remove index hints (e.g.no extractable index). */
  async removeIndexHintsFile(): Promise<void> {
    try {
      await fs.unlink(path.join(this.libraryDir, "index-hints.json"));
    } catch {
      /* missing file */
    }
    this.indexHintsByDocument = null;
  }
}
