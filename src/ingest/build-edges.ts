import { normalizeConcept } from "../lib/concepts";
import type { GraphEdge, Zettel } from "../types";

function edgeDedupKey(e: GraphEdge): string {
  return `${e.src}|${e.dst}|${e.type}|${e.concept ?? ""}`;
}

function pushEdge(edges: GraphEdge[], seen: Set<string>, e: GraphEdge): void {
  const k = edgeDedupKey(e);
  if (seen.has(k)) return;
  seen.add(k);
  edges.push(e);
}

/**
 * Prev/next ordering within document + bidirectional defines/references/concept coupling + fuzzy see_also.
 */
export function buildEdgesForLibrary(zettels: Zettel[]): GraphEdge[] {
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();

  const byDoc = new Map<string, Zettel[]>();
  for (const z of zettels) {
    const arr = byDoc.get(z.documentId) ?? [];
    arr.push(z);
    byDoc.set(z.documentId, arr);
  }

  for (const list of byDoc.values()) {
    const sorted = [...list].sort((a, b) => a.sectionIndex - b.sectionIndex);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const next = sorted[i];
      pushEdge(edges, seen, {
        src: prev.id,
        dst: next.id,
        type: "next_section",
        weight: 1,
      });
      pushEdge(edges, seen, {
        src: next.id,
        dst: prev.id,
        type: "prev_section",
        weight: 1,
      });
    }
  }

  const byConceptDefines = new Map<string, Zettel[]>();
  const byConceptRefs = new Map<string, Zettel[]>();
  for (const z of zettels) {
    for (const c of z.definesConcepts) {
      const arr = byConceptDefines.get(c) ?? [];
      arr.push(z);
      byConceptDefines.set(c, arr);
    }
    for (const c of z.referencesConcepts) {
      const arr = byConceptRefs.get(c) ?? [];
      arr.push(z);
      byConceptRefs.set(c, arr);
    }
  }

  for (const [concept, defs] of byConceptDefines) {
    const refs = byConceptRefs.get(concept);
    if (!refs) continue;
    for (const dz of defs) {
      for (const rz of refs) {
        if (dz.id === rz.id) continue;
        pushEdge(edges, seen, {
          src: rz.id,
          dst: dz.id,
          type: "references",
          concept,
          weight: 0.85,
        });
        pushEdge(edges, seen, {
          src: dz.id,
          dst: rz.id,
          type: "defines",
          concept,
          weight: 0.85,
        });
      }
    }
  }

  for (const z of zettels) {
    const also = z.seeAlsoTitles;
    if (!also) continue;
    const zt = normalizeConcept(z.title);
    for (const hint of also) {
      const h = normalizeConcept(hint);
      if (!h || h === zt) continue;
      for (const cand of zettels) {
        if (cand.id === z.id || cand.documentId !== z.documentId) continue;
        const ct = normalizeConcept(cand.title);
        if (ct.includes(h) || h.includes(ct)) {
          pushEdge(edges, seen, {
            src: z.id,
            dst: cand.id,
            type: "see_also",
            weight: 0.5,
          });
        }
      }
    }
  }

  return edges;
}
