/**
 * Normalize RPG / rulebook concepts for indexing and deduplication across zettels.
 */
export function normalizeConcept(raw: string): string {
  let s = raw.trim().toLowerCase();
  s = s.replace(/\s+/g, " ");
  /* Drop parenthetical disambiguators in keys: "Impaired (affliction)" → "impaired affliction" */
  s = s.replace(/\([^)]*\)/g, " ");
  /* Common punctuation cleanup */
  s = s.replace(/['’´`]/g, "'");
  s = s.replace(/\s+/g, " ").trim();
  return s.replace(/\.$/, "").trim();
}

/**
 * Loose match between a zettel `definesConcept` key and a normalized query phrase from
 * `conceptQueryPhrases` — conservative on short tokens to reduce noise.
 */
export function retrievalConceptOverlaps(
  normalizedDefine: string,
  normalizedPhrase: string,
): boolean {
  const d = normalizedDefine.trim();
  const p = normalizedPhrase.trim();
  if (!d || !p) return false;
  if (d === p) return true;
  /* Long substring: "multiple afflictions" ⊃ "multiple" */
  if (p.length >= 5 && d.includes(p)) return true;
  if (d.length >= 5 && p.includes(d)) return true;
  /* Glossary adjunct: impaired ↔ impaired affliction */
  if (p.length >= 4 && (d.startsWith(`${p} `) || d.endsWith(` ${p}`))) {
    return true;
  }
  if (d.length >= 4 && (p.startsWith(`${d} `) || p.endsWith(` ${d}`))) {
    return true;
  }
  return false;
}
