import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeConcept } from "../lib/concepts";
import type { Provider } from "../providers/types";
import type { Zettel } from "../types";
import { ENRICH_PROMPT_VERSION } from "./zettelize";

export const ZettelEnrichSchema = z.object({
  concepts: z.array(z.string()).default([]),
  definesConcepts: z.array(z.string()).default([]),
  referencesConcepts: z.array(z.string()).default([]),
  seeAlsoTitles: z.array(z.string()).optional(),
  confidence: z.number().min(0).max(1).optional(),
});

export type ZettelEnrichParsed = z.infer<typeof ZettelEnrichSchema>;

export function enrichmentCacheHash(synopsis: string): string {
  const payload = `${ENRICH_PROMPT_VERSION}:${synopsis}`;
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

/** Drop defines claims unsupported by verbatim-ish presence in synopsis. */
export function sanityFilterDefines(z: Zettel): void {
  const syn = z.synopsis.toLowerCase();
  z.definesConcepts = z.definesConcepts.filter((c) => {
    if (!c) return false;
    return syn.includes(c) || syn.includes(c.replace(/\s+/g, " "));
  });
}

export function normalizeEnrichmentLists(out: ZettelEnrichParsed): {
  concepts: string[];
  definesConcepts: string[];
  referencesConcepts: string[];
  seeAlsoTitles?: string[];
} {
  const norm = (arr: string[]) => [
    ...new Set(arr.map(normalizeConcept).filter(Boolean)),
  ];
  const see = out.seeAlsoTitles?.map((s) => s.trim()).filter(Boolean);
  return {
    concepts: norm(out.concepts),
    definesConcepts: norm(out.definesConcepts),
    referencesConcepts: norm(out.referencesConcepts),
    seeAlsoTitles: see && see.length > 0 ? see : undefined,
  };
}

function buildEnrichPrompt(z: Zettel): string {
  return `You extract structured RPG rulebook concepts for retrieval. Reply with ONE JSON object only.

Fields:
- concepts: mechanical noun phrases mentioned (max 24)
- definesConcepts: concepts this excerpt DEFINES or lays down primary rules for (max 12)
- referencesConcepts: concepts cited but not primarily defined here (max 12)
- seeAlsoTitles: section headings this text likely cross-references (max 8)
- confidence: number 0-1 how reliable this labeling is

SECTION_TITLE:
${JSON.stringify(z.title)}
TEXT:
${z.synopsis}
`;
}

/**
 * Populate z.concepts, definesConcepts, referencesConcepts; cache per synopsis hash under libraryDir/.cache/llm-enrich.
 */
export async function enrichZettelsWithLlM(
  provider: Provider,
  zettels: Zettel[],
  libraryDir: string,
): Promise<void> {
  const cacheDir = path.join(libraryDir, ".cache", "llm-enrich");
  await fs.mkdir(cacheDir, { recursive: true });

  let done = 0;
  for (const z of zettels) {
    done++;
    const key = enrichmentCacheHash(z.synopsis);
    const fp = path.join(cacheDir, `${key}.json`);

    try {
      const cached = JSON.parse(await fs.readFile(fp, "utf8"));
      const parsed = ZettelEnrichSchema.parse(cached);
      const n = normalizeEnrichmentLists(parsed);
      z.concepts = n.concepts;
      z.definesConcepts = n.definesConcepts;
      z.referencesConcepts = n.referencesConcepts;
      z.seeAlsoTitles = n.seeAlsoTitles;
      sanityFilterDefines(z);
      continue;
    } catch {
      /* miss */
    }

    process.stdout.write(
      `\rLLM enrich ${done}/${zettels.length} ${z.documentId.slice(0, 20)}…#${z.sectionIndex}   `,
    );
    try {
      const raw = await provider.generateStructured(
        buildEnrichPrompt(z),
        ZettelEnrichSchema,
      );
      await fs.writeFile(fp, JSON.stringify(raw, null, 2), "utf8");
      const n = normalizeEnrichmentLists(raw);
      z.concepts = n.concepts;
      z.definesConcepts = n.definesConcepts;
      z.referencesConcepts = n.referencesConcepts;
      z.seeAlsoTitles = n.seeAlsoTitles;
      sanityFilterDefines(z);
    } catch {
      console.error(`\n[enrich failed] ${z.id}`);
    }
  }
  console.log("");
}
