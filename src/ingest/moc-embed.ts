import type { Provider } from "../providers/types";

/**
 * Embed MOC scope summaries alongside ingest (caller saves vectors.bin).
 */
export async function embedMocSummaries(
  provider: Provider,
  summaries: string[],
): Promise<number[][]> {
  if (summaries.length === 0) return [];
  if (provider.embedBatch) {
    return provider.embedBatch(summaries);
  }
  const out: number[][] = [];
  for (const s of summaries) {
    out.push(await provider.embed(s));
  }
  return out;
}
