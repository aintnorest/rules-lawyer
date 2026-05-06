import { z } from "zod";
import type { Provider } from "../providers/types";
import type { DocumentMoc, LibraryManifest, Zettel } from "../types";

const MocSummarySchema = z.object({
  scopeSummary: z.string(),
});

export async function buildDocumentMocs(
  provider: Provider,
  zettels: Zettel[],
  manifest: LibraryManifest,
): Promise<DocumentMoc[]> {
  const libraryId = manifest.id;
  const docIds = [...new Set(zettels.map((z) => z.documentId))];
  const labelMap = new Map(manifest.documents.map((d) => [d.id, d.label]));

  const out: DocumentMoc[] = [];

  for (const docId of docIds) {
    const zs = zettels.filter((z) => z.documentId === docId);
    const conceptFreq = new Map<string, number>();
    const authoritativeForSet = new Set<string>();
    for (const z of zs) {
      for (const c of z.definesConcepts) authoritativeForSet.add(c);
      for (const c of z.concepts)
        conceptFreq.set(c, (conceptFreq.get(c) ?? 0) + 1);
    }
    const topConcepts = [...conceptFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k]) => k);
    const authoritativeFor = [...authoritativeForSet].sort();

    const rollup = zs
      .map(
        (z) =>
          `## ${z.title}\ntopics: ${z.concepts.slice(0, 12).join(", ")}\ndefines: ${z.definesConcepts.join(", ")}\nrefs: ${z.referencesConcepts.slice(0, 8).join(", ")}`,
      )
      .join("\n\n");
    const truncated = provider.truncateToTokens(rollup, 3500);

    const prompt = `You write Map-of-Content scope notes for tabletop RPG PDFs. Respond with JSON matching { "scopeSummary": string }.

Requirements for scopeSummary:
- 2–5 complete sentences in English.
- Say what rules or subsystems this PDF primarily covers.
- Say what it mostly references vs fully defines (based on the rollup).
- Avoid inventing page numbers or edition names not in the rollup.

ROLLUP:
${truncated}
`;

    try {
      const parsed = await provider.generateStructured(
        prompt,
        MocSummarySchema,
      );
      out.push({
        documentId: docId,
        libraryId,
        label: labelMap.get(docId) ?? docId,
        scopeSummary: parsed.scopeSummary.trim(),
        topConcepts,
        authoritativeFor,
      });
    } catch {
      out.push({
        documentId: docId,
        libraryId,
        label: labelMap.get(docId) ?? docId,
        scopeSummary: `${labelMap.get(docId) ?? docId}: rules reference (MOC generation failed; using concept roll-up).`,
        topConcepts,
        authoritativeFor,
      });
    }
  }

  return out;
}
