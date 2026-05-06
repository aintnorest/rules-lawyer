import type { Provider } from "../providers/types";
import type { Chunk } from "../types";
import { splitPageIntoSegments } from "./headings";

/**
 * Token windows with overlap, split at page-derived **heading segments** so a section
 * title does not glue unrelated bodies into one chunk.
 */
export function chunkDocument(
  provider: Provider,
  documentId: string,
  libraryId: string,
  pages: Array<{ pageNumber: number; content: string }>,
  targetTokens: number,
  overlapTokens: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  const chunkIndexRef = { n: 0 };

  for (const page of pages) {
    const segments = splitPageIntoSegments(page.pageNumber, page.content);

    for (const seg of segments) {
      const words = seg.content.split(/\s+/).filter(Boolean);
      let currentWords: string[] = [];
      let pageStart = seg.pageNumber;

      for (const word of words) {
        currentWords.push(word);
        const approxTokens = currentWords.length * 3;

        if (approxTokens >= targetTokens) {
          const text = currentWords.join(" ");
          const exactTokens = provider.countTokens(text);
          if (exactTokens >= targetTokens) {
            const idx = chunkIndexRef.n++;
            chunks.push({
              id: `${documentId}#${idx}`,
              libraryId,
              documentId,
              chunkIndex: idx,
              pageStart,
              pageEnd: seg.pageNumber,
              text,
              tokenCount: exactTokens,
              ...(seg.sectionHeading ? { sectionHeading: seg.sectionHeading } : {}),
            });

            const overlapWordCount = Math.floor(overlapTokens / 3);
            currentWords = currentWords.slice(-overlapWordCount);
            pageStart = seg.pageNumber;
          }
        }
      }

      if (currentWords.length > 0) {
        const text = currentWords.join(" ");
        const exactTokens = provider.countTokens(text);
        if (exactTokens > 10) {
          const idx = chunkIndexRef.n++;
          chunks.push({
            id: `${documentId}#${idx}`,
            libraryId,
            documentId,
            chunkIndex: idx,
            pageStart,
            pageEnd: seg.pageNumber,
            text,
            tokenCount: exactTokens,
            ...(seg.sectionHeading
              ? { sectionHeading: seg.sectionHeading }
              : {}),
          });
        }
      }
    }
  }

  return chunks;
}
