import { z } from "zod";
import { config } from "../config";
import { provider } from "../providers/ollama";
import type { Chunk } from "../types";
import { buildPrompt, trimChunksForPrompt } from "./prompt";
import {
  fullCorpusLexicalScore,
  retrievalTermsFromQuestion,
} from "./retrieval";

/**
 * Models sometimes echo the excerpt header, e.g. `CHUNK_ID: doc#214` instead of `doc#214`,
 * which breaks `getChunkById` and falsely triggers provenance fallback.
 */
export function normalizeModelChunkId(raw: string): string {
  return raw
    .trim()
    .replace(/^CHUNK_ID\s*:\s*/i, "")
    .trim();
}

export const ModelOutputSchema = z
  .object({
    answer: z.string().catch("Unable to generate an answer."),
    spokenSummary: z.string().optional().catch(""),
    confidence: z
      .enum(["high", "mixed", "not_in_book", "speculative"])
      .catch("not_in_book"),
    citedChunkIds: z.array(z.string()).optional().catch([]),
    cited_from: z.any().optional(),
  })
  .transform((val) => {
    const rawIds =
      val.citedChunkIds && val.citedChunkIds.length > 0
        ? val.citedChunkIds
        : Array.isArray(val.cited_from)
          ? val.cited_from.map(String)
          : typeof val.cited_from === "string"
            ? [val.cited_from]
            : [];
    const citedChunkIds = rawIds
      .map((id) => normalizeModelChunkId(id))
      .filter((id) => id.length > 0);
    return {
      answer: val.answer,
      spokenSummary: val.spokenSummary || "",
      confidence: val.confidence,
      citedChunkIds,
    };
  });

export type GeneratedAnswer = z.infer<typeof ModelOutputSchema>;

/** How much lexical question↔chunk score reshuffles excerpts before the token trim (blend with retrieval order). */
const LEXICAL_REORDER_BLEND = 0.48;

/** Small models sometimes emit not_in_book alongside invented rules; downgrade when the answer clearly isn't a "missing" reply. */
function reconcileConfidence(
  output: GeneratedAnswer,
  chunksInPrompt: Chunk[],
): GeneratedAnswer {
  if (
    output.confidence === "not_in_book" &&
    chunksInPrompt.length > 0 &&
    output.citedChunkIds.length > 0
  ) {
    return { ...output, confidence: "mixed" };
  }
  if (
    output.confidence === "not_in_book" &&
    chunksInPrompt.length > 0 &&
    output.citedChunkIds.length === 0
  ) {
    const soundsInvented =
      /\b(typically|here's how|it works|stacks with)\b/i.test(output.answer);
    const soundsDefinitive =
      /\b(does not|do not|never stacks|always|cannot|can't|rules state|according to the excerpts)\b/i.test(
        output.answer,
      );
    if (
      soundsInvented ||
      output.answer.length > 200 ||
      (soundsDefinitive && output.answer.length > 35)
    ) {
      return { ...output, confidence: "mixed" };
    }
  }
  return output;
}

/**
 * Tiny models sometimes write a contradictory spokenSummary vs answer on stacking/instance rules.
 */
function reconcileSpokenSummary(output: GeneratedAnswer): GeneratedAnswer {
  const spoken = output.spokenSummary.trim();
  const answer = output.answer.trim();
  if (!spoken || !answer) return output;

  const spokenSaysNoStack =
    /\b(does\s+not\s+stack|don't\s+stack|never\s+stacks)\b/i.test(spoken);
  const answerSaysMechanicsWithoutNoStackDenial =
    /\b(stack|stacks|each\s+instance|instances?\s+of)\b/i.test(answer) &&
    !/\b(does\s+not\s+stack|don't\s+stack|never\s+stacks|cannot\s+stack)\b/i.test(
      answer,
    );

  if (spokenSaysNoStack && answerSaysMechanicsWithoutNoStackDenial) {
    const clipped = answer.replace(/\s+/g, " ").trim();
    const slice = clipped.length > 280 ? `${clipped.slice(0, 277)}…` : clipped;
    return { ...output, spokenSummary: slice };
  }
  return output;
}

export async function generateAnswer(
  _libraryId: string,
  question: string,
  chunks: Chunk[],
  history: Array<{ role: string; content: string }>,
): Promise<{ output: GeneratedAnswer; chunksInPrompt: Chunk[] }> {
  const terms = retrievalTermsFromQuestion(question);
  const chunksForPrompt =
    chunks.length <= 1
      ? [...chunks]
      : (() => {
          const n = chunks.length;
          const scored = chunks.map((c, i) => ({
            c,
            i,
            lex: fullCorpusLexicalScore(question, terms, c),
          }));
          const maxL = Math.max(...scored.map((x) => x.lex), 1e-9);
          const minL = Math.min(...scored.map((x) => x.lex));
          const span = maxL - minL || 1;
          return scored
            .map(({ c, i, lex }) => {
              const normLex = (lex - minL) / span;
              const normRetrieval =
                n <= 1 ? 1 : (n - 1 - i) / Math.max(n - 1, 1);
              const combined =
                LEXICAL_REORDER_BLEND * normLex +
                (1 - LEXICAL_REORDER_BLEND) * normRetrieval;
              return { c, i, combined };
            })
            .sort((a, b) => {
              if (b.combined !== a.combined) return b.combined - a.combined;
              return a.i - b.i;
            })
            .map((x) => x.c);
        })();

  const chunksInPrompt = trimChunksForPrompt(
    provider,
    chunksForPrompt,
    config.retrieveExcerptTokenBudget,
  );
  const prompt = buildPrompt(provider, question, chunksInPrompt, history);
  const raw = await provider.generateStructured(prompt, ModelOutputSchema);
  const output = reconcileSpokenSummary(
    reconcileConfidence(raw, chunksInPrompt),
  );
  return { output, chunksInPrompt };
}
