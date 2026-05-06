import type { Chunk } from "../types";

/** Text used for embedding and lexical scoring so headings stay aligned with body. */
export function chunkTextWithHeading(chunk: Chunk): string {
  const h = chunk.sectionHeading?.trim();
  if (!h) return chunk.text;
  return `${h}\n\n${chunk.text}`;
}
