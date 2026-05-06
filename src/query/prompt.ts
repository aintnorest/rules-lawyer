import { chunkTextWithHeading } from "../lib/chunk-text";
import type { Provider } from "../providers/types";
import type { Chunk } from "../types";

/** Drop lowest-priority tail chunks so excerpt blocks stay within an estimated token budget (order preserved). */
export function trimChunksForPrompt(
  provider: Provider,
  chunks: Chunk[],
  maxExcerptTokens: number,
): Chunk[] {
  const out: Chunk[] = [];
  let used = 0;
  for (const c of chunks) {
    const block = `[CHUNK_ID: ${c.id}]\n${chunkTextWithHeading(c)}\n`;
    const t = provider.countTokens(block);
    if (out.length > 0 && used + t > maxExcerptTokens) break;
    out.push(c);
    used += t;
  }
  return out;
}

export function buildPrompt(
  provider: Provider,
  question: string,
  chunks: Chunk[],
  history: Array<{ role: string; content: string }>,
  historyBudget: number = 1500,
): string {
  const systemPrompt = `You are a rules assistant. You only see labeled excerpts from rulebooks below—nothing else.

Hard requirements:
1. Use ONLY the excerpts. No outside knowledge, other editions, or general RPG heuristics unless the excerpt itself states it.
2. If the excerpts let you answer (fully or partially), set confidence to "high" or "mixed" and list EVERY excerpt you relied on in citedChunkIds. Each element must be **only** the id string copied from the excerpt header — e.g. \`sdl1000-…-pdf#214\`. Do NOT prefix with \`CHUNK_ID:\`, quotes, brackets, or any label. A substantive answer MUST have at least one citedChunkId.
3. Use "not_in_book" ONLY when no excerpt applies. Then answer must be ONE short sentence that the excerpts do not address the question; citedChunkIds must be []. Do not explain the game, do not guess mechanics, do not use the game's title as if you know it from elsewhere.
4. Never combine "not_in_book" with a detailed mechanical explanation—those contradict each other.
5. Questions about stacking, duplicates, multiple instances, or layering effects: look for general rules in the excerpts (e.g. "already have," "no additional effect," "multiple," afflictions/conditions). A short general rule next to a definition often applies to that definition — you MUST cite BOTH the general rule excerpt(s) AND the named condition excerpt(s) if you use both.
6. If the question names a game term (e.g. a condition, talent, or spell name), the glossary line that defines it is useful context, but when you also explain **stacking, duplicate instances, "each instance," removing multiple copies, or whether there is "no additional effect"**, you MUST include citedChunkIds for the excerpt(s) that state that **general** rule. Citing only a one-line glossary chunk (e.g. "Impaired An impaired creature…") is WRONG when your answer invokes those mechanics.
7. Never contradict yourself: spokenSummary MUST agree with "answer" on whether effects stack / duplicate instances work the same way / whether extra copies add power.
8. Do NOT say a condition "has no stacking rule in the excerpts" when any excerpt contains **Multiple Afflictions** (or similar language about gaining an affliction you already have, no additional effect, removing each instance)—that IS the general rule applied to all afflictions unless an excerpt carves out an exception.
9. If your answer explains the **Multiple Afflictions** rule, open with that applicability (e.g. the named condition follows the general rule) instead of claiming the excerpts lack stacking language while quoting that rule verbatim in the next sentence.
10. **citedChunkIds must support what you actually claim.** If the question names topics (e.g. incapacitation, healing, recovery, whether a character may act on a turn), cite excerpt(s) that **address those topics**, not unrelated examples (e.g. generic fast/slow turn examples) unless those excerpts are the only ones that state the rule you need.
11. Do NOT open by saying excerpts "do not provide" / "do not specify" the rule **when citedChunkIds include** an excerpt whose text literally states it (especially **Multiple Afflictions** for stacking-of-afflictions questions). Lead with what that cited excerpt establishes.
12. **Inventory / counting** ("how many…", "list all…"): Search excerpts for headings or prose that enumerate the queried category (e.g. chapters titled **Classes** listing each class/path). When excerpts list distinct entries (bullets, named items, spaced bold lines), **count only what is visibly listed** across the excerpts shown and cite **every** excerpt you relied on for that tally — no outside knowledge ("the book famously has twelve…"). If the excerpts clearly enumerate the full set within what you see, give the numeric total confidently. If the list appears **truncated** (enumeration runs into "…") or spills across excerpts you partially see, respond with **mixed** confidence, cite the partial list, explain coverage is imperfect, **do not** fabricate unseen entries.
13. **"How many classes" vs subsets:** excerpts may list **only** prerequisites or examples (multiclass prerequisites, caster lists). If the enumerated names are labelled or clearly tied to multiclass prerequisites, report that as a **partial list** (**e.g.** five caster classes), **not** the full character-class roster—and say so plainly. Prefer excerpts whose heading is the **Characters / Classes overview** listing every playable class. Do not treat a multiclass prerequisites table as exhaustive for "how many classes are there."
14. **citedChunkIds** must be copied from excerpt headers: use **only** the exact strings appearing as \`[CHUNK_ID: …]\` above in Rules Excerpts. Never invent IDs, never cite a chunk/page you cannot see in those headers, and never output a citation that is missing from Rules Excerpts.

You MUST respond with a JSON object that EXACTLY matches this schema:
{
  "answer": "your full detailed answer to the question",
  "spokenSummary": "a very short 1-2 sentence summary of the answer",
  "confidence": "high" | "mixed" | "not_in_book" | "speculative",
  "citedChunkIds": ["array", "of", "exact", "CHUNK_ID", "strings"]
}

Rules Excerpts:
${chunks.map((c) => `[CHUNK_ID: ${c.id}]\n${chunkTextWithHeading(c)}\n`).join("\n---\n")}
`;

  let historyText = "";
  let currentTokens = 0;
  const reversedHistory = [...history].reverse();
  const keptHistory = [];
  for (const msg of reversedHistory) {
    const msgText = `${msg.role}: ${msg.content}\n`;
    const tokens = provider.countTokens(msgText);
    if (currentTokens + tokens > historyBudget) break;
    currentTokens += tokens;
    keptHistory.unshift(msg);
  }

  if (keptHistory.length > 0) {
    historyText =
      "Chat History:\n" +
      keptHistory.map((m) => `${m.role}: ${m.content}`).join("\n") +
      "\n\n";
  }

  return `${systemPrompt}\n\n${historyText}User Question: ${question}`;
}
