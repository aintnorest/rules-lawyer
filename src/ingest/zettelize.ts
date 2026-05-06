import type { Provider } from "../providers/types";
import type { Chunk, Zettel } from "../types";

export const GRAPH_VERSION = 1;
export const ENRICH_PROMPT_VERSION = 1;

export function syntheticSectionTitle(firstChunk: Chunk): string {
  return `Untitled (p. ${firstChunk.pageStart})`;
}

type Key = { docId: string; heading: string | undefined };

/**
 * Group consecutive chunks in global order that share the same document and
 * `sectionHeading` (undefined groups with undefined). Each group becomes one zettel.
 */
export function zettelizeLibrary(
  provider: Provider,
  chunks: Chunk[],
  libraryId: string,
  synopsisMaxTokens: number = 700,
): Zettel[] {
  if (chunks.length === 0) return [];

  const zettels: Zettel[] = [];
  const sectionIndexByDoc = new Map<string, number>();
  let currentKey: Key | null = null;
  let currentChunks: Chunk[] = [];

  const flush = () => {
    if (!currentKey || currentChunks.length === 0) return;
    const { docId, heading } = currentKey;
    const secIdx = sectionIndexByDoc.get(docId) ?? 0;
    sectionIndexByDoc.set(docId, secIdx + 1);

    const first = currentChunks[0];
    const last = currentChunks[currentChunks.length - 1];
    const title =
      heading !== undefined ? heading : syntheticSectionTitle(first);

    const body = currentChunks.map((c) => c.text).join("\n\n");
    const synopsisHead = `${title}\n\n`;
    let synopsis = synopsisHead + body;
    synopsis = provider.truncateToTokens(synopsis, synopsisMaxTokens);

    zettels.push({
      id: `${docId}#sec:${secIdx}`,
      libraryId,
      documentId: docId,
      sectionIndex: secIdx,
      title,
      pageStart: first.pageStart,
      pageEnd: last.pageEnd,
      chunkIds: currentChunks.map((c) => c.id),
      synopsis,
      concepts: [],
      definesConcepts: [],
      referencesConcepts: [],
    });

    currentChunks = [];
  };

  for (const c of chunks) {
    const nextKey: Key = { docId: c.documentId, heading: c.sectionHeading };
    if (
      currentKey &&
      (currentKey.docId !== nextKey.docId ||
        currentKey.heading !== nextKey.heading)
    ) {
      flush();
      currentKey = null;
    }
    if (currentChunks.length === 0) currentKey = nextKey;
    currentChunks.push(c);
  }
  flush();

  return zettels;
}
