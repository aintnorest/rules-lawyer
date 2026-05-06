import type { Chunk, GraphEdge, GraphEdgeType, Zettel } from "../types";

/**
 * Expand from seed chunks to related zettels (1-hop) and return chunk corpus indices → boost scores.
 */
export function graphNeighborChunkBoosts(opts: {
  seedChunkIds: string[];
  chunks: Chunk[];
  zettels: Zettel[];
  edges: GraphEdge[];
  chunkIdToZettelId: Map<string, string>;
  allowedTypes: Set<GraphEdgeType>;
  expandPerSeed: number;
  baseWeight: number;
}): Map<number, number> {
  const {
    seedChunkIds,
    chunks,
    zettels,
    edges,
    chunkIdToZettelId,
    allowedTypes,
    expandPerSeed,
    baseWeight,
  } = opts;

  const chunkIndexById = new Map<string, number>();
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    if (c) chunkIndexById.set(c.id, i);
  }
  const zettelById = new Map(zettels.map((z) => [z.id, z]));

  const adj = new Map<string, Array<{ peer: string; w: number }>>();
  const addAdj = (a: string, b: string, w: number) => {
    const la = adj.get(a) ?? [];
    la.push({ peer: b, w });
    adj.set(a, la);
  };

  for (const e of edges) {
    if (!allowedTypes.has(e.type)) continue;
    addAdj(e.src, e.dst, e.weight);
    addAdj(e.dst, e.src, e.weight);
  }

  const boosts = new Map<number, number>();
  const applyZettel = (zettelId: string, multiplier: number) => {
    const z = zettelById.get(zettelId);
    if (!z) return;
    const b = baseWeight * multiplier;
    for (const cid of z.chunkIds) {
      const ix = chunkIndexById.get(cid);
      if (ix === undefined) continue;
      boosts.set(ix, Math.max(boosts.get(ix) ?? 0, b));
    }
  };

  const seenPairs = new Set<string>();
  for (const cid of seedChunkIds) {
    const zid = chunkIdToZettelId.get(cid);
    if (!zid) continue;
    const neigh = adj.get(zid) ?? [];
    neigh.sort((a, b) => b.w - a.w);
    let taken = 0;
    for (const { peer, w } of neigh) {
      if (taken >= expandPerSeed) break;
      const pairKey = `${zid}->${peer}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      applyZettel(peer, w);
      taken++;
    }
  }

  return boosts;
}
