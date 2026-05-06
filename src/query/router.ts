import { cosineSimilarity } from "../lib/similarity";

/**
 * Soft per-document boosts from cosine(MOC_embedding, query_embedding).
 * Normalizes scores by the best-matching PDF so boosts stay bounded.
 */
export function documentRouterBoostMap(
  queryEmbedding: number[],
  mocVectors: Float32Array[],
  documentIds: string[],
  weight: number,
): Map<string, number> {
  const out = new Map<string, number>();
  if (weight <= 0 || documentIds.length === 0 || mocVectors.length === 0) {
    return out;
  }
  const sims = documentIds.map((docId, i) => {
    const vec = mocVectors[i];
    const s = vec && vec.length > 0 ? cosineSimilarity(queryEmbedding, vec) : 0;
    return { docId, s };
  });
  const mx = Math.max(...sims.map((x) => x.s), 1e-12);
  for (const { docId, s } of sims) out.set(docId, weight * (s / mx));
  return out;
}
