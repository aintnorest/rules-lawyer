/**
 * Optional per-library map: back-of-book (or PDF) index → page numbers used as printed
 * in extracted text (`Chunk.pageStart` / `pageEnd`), i.e. the same numbering as ingestion.
 *
 * Automatic “does this book have an index?” is fragile (multicolumn OCR, dot leaders,
 * mismatch between printed and digital page labels). Prefer generating this file from a
 * clean index pass or by hand for high-value books, then retrieval adds a small boost
 * when a question term matches an index entry and the chunk covers a listed page.
 *
 * During **`pnpm ingest`**, `index-extract.ts` heuristically fills `index-hints.json` unless `--no-index` is passed.
 */

import type { Chunk } from "../types";

export type IndexHintsFile = {
  version?: number;
  /** documentId (slug) → index heading (any casing) → PDF/logical pages where that topic appears */
  byDocument: Record<string, Record<string, number[]>>;
};

export function normalizeIndexKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Match index heading to a query term (e.g. "Impaired (affliction)" ↔ "impaired"). */
export function indexKeyMatchesTerm(
  keyNorm: string,
  termNorm: string,
): boolean {
  if (termNorm.length < 2) return false;
  if (keyNorm === termNorm) return true;
  if (keyNorm.startsWith(`${termNorm} (`)) return true;
  if (keyNorm.startsWith(`${termNorm} `)) return true;
  return false;
}

function hintedPagesForTerms(
  docHints: Record<string, number[]>,
  queryTerms: string[],
): Set<number> {
  const pages = new Set<number>();
  const entries = Object.entries(docHints).map(
    ([k, p]) => [normalizeIndexKey(k), p] as const,
  );
  for (const raw of queryTerms) {
    const t = normalizeIndexKey(raw);
    for (const [k, plist] of entries) {
      if (indexKeyMatchesTerm(k, t)) {
        for (const p of plist) pages.add(p);
      }
    }
  }
  return pages;
}

/**
 * One-shot boost if this chunk spans any page the index lists for matched query terms.
 * `weight` is added at most once per chunk.
 */
export function indexHintBoostForChunk(
  chunk: Pick<Chunk, "documentId" | "pageStart" | "pageEnd">,
  queryTerms: string[],
  hintsByDocument: Record<string, Record<string, number[]>> | null,
  weight: number,
): number {
  if (!hintsByDocument || weight <= 0 || queryTerms.length === 0) return 0;
  const docHints = hintsByDocument[chunk.documentId];
  if (!docHints) return 0;
  const hinted = hintedPagesForTerms(docHints, queryTerms);
  if (hinted.size === 0) return 0;
  for (const p of hinted) {
    if (p >= chunk.pageStart && p <= chunk.pageEnd) return weight;
  }
  return 0;
}

export function parseIndexHintsJson(
  raw: string,
): Record<string, Record<string, number[]>> | null {
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    let by: unknown;
    if (data && typeof data === "object" && "byDocument" in data) {
      by = data.byDocument;
    } else {
      by = data;
    }
    if (!by || typeof by !== "object") return null;
    const out: Record<string, Record<string, number[]>> = {};
    for (const [docId, hintMap] of Object.entries(by)) {
      if (docId === "version" || docId === "byDocument") continue;
      if (!hintMap || typeof hintMap !== "object") continue;
      const nested: Record<string, number[]> = {};
      for (const [k, pages] of Object.entries(
        hintMap as Record<string, unknown>,
      )) {
        if (!Array.isArray(pages)) continue;
        nested[k] = pages.filter((p): p is number => typeof p === "number");
      }
      if (Object.keys(nested).length > 0) out[docId] = nested;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}
