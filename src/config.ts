import fs from "fs";
import path from "path";
import { z } from "zod";

const LibraryConfigSchema = z.object({
  id: z.string().optional(), // optional, can be generated from path
  path: z.string(), // filesystem path or glob
  label: z.string().optional(),
});

const ConfigSchema = z.object({
  dataDir: z.string().default("./data"),
  libraries: z.array(LibraryConfigSchema).default([]),
  llmModel: z.string().default(process.env.LLM_MODEL || "qwen2.5:3b-instruct"),
  embedModel: z.string().default(process.env.EMBED_MODEL || "nomic-embed-text"),
  ollamaBaseUrl: z
    .string()
    .default(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434"),
  historyBudget: z.number().default(1500),
  /** Dense retrieval: how many chunks to rank by embedding similarity before neighbor expansion. */
  retrieveTopK: z.number().default(10),
  /**
   * Include chunks at chunkIndex ± this value within the same document for each top-K hit.
   * 0 = no expansion (pure top-K only).
   */
  retrieveNeighborWindow: z.number().default(1),
  /**
   * Estimated token budget for concatenated excerpt blocks in the LLM prompt (CHUNK_ID + text each).
   * Truncates lowest-priority retrieved chunks first to avoid overwhelming small local models.
   */
  retrieveExcerptTokenBudget: z.number().default(3800),
  /** Dense hits to keep before lexical reranking (wider pool helps glossary hits survive). */
  retrieveCandidatePool: z.number().default(96),
  /** Weight on lexical term coverage when reranking inside the pool (see `src/query/retrieval.ts`). */
  retrieveLexicalWeight: z.number().default(0.2),
  /**
   * Merge top-N chunks by full-corpus lexical + rule-phrase score into the retrieval pool (union with dense top `retrieveCandidatePool`).
   * Set to 0 to disable. Helps when book wording (e.g. "Multiple Afflictions") does not match query embeddings.
   */
  retrieveHybridLexicalTopK: z.number().default(24),
  /** Max primary hits per source PDF before other books get slots (remaining top-K filled by score). */
  retrieveMaxChunksPerDocument: z.number().default(2),
  /** Only the first N primary hits trigger ± `retrieveNeighborWindow` neighbor expansion. */
  retrieveNeighborExpandTop: z.number().default(3),
  /** Max chunks per PDF in provenance fallback citations when the model cites nothing. */
  retrieveProvenanceMaxPerDocument: z.number().default(2),
  /** Small boost when chunk pages match optional `index-hints.json` for query terms (0 = disabled). */
  retrieveIndexHintBoost: z.number().default(0.07),
  /** MOC cosine router: normalized per-doc boost × this weight inside merged retrieval pool (R2). */
  retrieveDocRouterWeight: z.number().default(0),
  /** Dense hits used as graph expansion seeds when `retrieveGraphExpandWeight` > 0. */
  retrieveGraphSeedCount: z.number().default(24),
  /** Max 1-hop zettel neighbors expanded per dense seed chunk. */
  retrieveGraphExpandPerHit: z.number().default(3),
  /** Boost pooled chunks from graph neighbors; 0 disables graph pooling (R0). */
  retrieveGraphExpandWeight: z.number().default(0),
  /** Edge types used when traversing Zettel graph for retrieval. */
  retrieveGraphEdgeTypes: z
    .array(z.string())
    .default(["defines", "references", "see_also"]),
  /**
   * Additive pool + rerank: chunks whose zettel **definesConcepts** overlap `conceptQueryPhrases(question)`.
   * **0** = off (matches prior pipelines).
   */
  retrieveDefineConceptWeight: z.number().default(0),
  /** Max chunks seeded from definesConcept matching per query (top by hit count). */
  retrieveDefineConceptMaxChunks: z.number().default(12),
});

export type AppConfig = z.infer<typeof ConfigSchema>;
export type LibraryConfig = z.infer<typeof LibraryConfigSchema>;

export function loadConfig(configPath?: string): AppConfig {
  const cwd = process.cwd();
  const defaultPaths = [path.join(cwd, "rules-lawyer.config.json")];

  let targetPath = configPath;
  if (!targetPath) {
    targetPath = defaultPaths.find((p) => fs.existsSync(p));
  }

  if (targetPath && fs.existsSync(targetPath)) {
    const content = fs.readFileSync(targetPath, "utf-8");
    return ConfigSchema.parse(JSON.parse(content));
  }

  // Return default config if no file exists
  return ConfigSchema.parse({});
}

// Singleton loaded config for app usage
export const config = loadConfig();
