import type { NextRequest } from "next/server";
import { config } from "../../../src/config";
import { formatResult } from "../../../src/query/format";
import { generateAnswer } from "../../../src/query/generate";
import { retrievalTermsFromQuestion } from "../../../src/query/retrieval";

import type { GraphEdgeType } from "../../../src/types";

export const runtime = "nodejs";

const MAX_QUESTION_CHARS = 32_768;

/** Reject malformed chat history before retrieval / LLM. */
function validatedHistory(
  raw: unknown,
): Array<{ role: string; content: string }> {
  if (!Array.isArray(raw)) {
    throw new Error(
      "Invalid request: `history` must be an array of { role, content }.",
    );
  }
  const out: Array<{ role: string; content: string }> = [];
  for (let i = 0; i < raw.length; i++) {
    const msg = raw[i];
    if (!msg || typeof msg !== "object") {
      throw new Error(`Invalid request: history[${i}] is not an object.`);
    }
    const row = msg as Record<string, unknown>;
    const role = row.role;
    const content = row.content;
    if (role !== "user" && role !== "assistant") {
      throw new Error(
        `Invalid request: history[${i}].role must be "user" or "assistant".`,
      );
    }
    if (typeof content !== "string") {
      throw new Error(
        `Invalid request: history[${i}].content must be a string.`,
      );
    }
    out.push({ role, content });
  }
  return out;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const rawLibraryId = body.libraryId;
  const rawQuestion = body.question;
  const rawHistory = body.history;

  const encoder = new TextEncoder();
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();

  const sendEvent = async (
    event: string,
    data?: Record<string, unknown> | unknown[] | string,
  ) => {
    let msg = `event: ${event}\n`;
    if (data) msg += `data: ${JSON.stringify(data)}\n`;
    msg += `\n`;
    await writer.write(encoder.encode(msg));
  };

  (async () => {
    try {
      const traces = { embedMs: 0, retrieveMs: 0, generateMs: 0 };

      const { provider } = await import("../../../src/providers/ollama");
      const { JsonVectorStore } = await import("../../../src/ingest/store");

      if (
        typeof rawLibraryId !== "string" ||
        rawLibraryId.trim().length === 0
      ) {
        throw new Error(
          `Missing or invalid libraryId (expected non-empty string). Send { libraryId, question, history? }.`,
        );
      }
      const libraryId = rawLibraryId.trim();

      const questionTrimmed =
        typeof rawQuestion === "string" ? rawQuestion.trim() : "";
      if (questionTrimmed.length === 0) {
        throw new Error(
          "Missing or invalid question (expected non-empty string after trimming).",
        );
      }
      if (questionTrimmed.length > MAX_QUESTION_CHARS) {
        throw new Error(
          `Question too long (max ${MAX_QUESTION_CHARS} characters).`,
        );
      }

      const history =
        rawHistory === undefined || rawHistory === null
          ? []
          : validatedHistory(rawHistory);

      console.log("[query]", {
        libraryId,
        questionChars: questionTrimmed.length,
        historyLen: history.length,
      });

      await sendEvent("status", "embedding");
      const startEmbed = Date.now();

      const embedVec = await provider.embed(questionTrimmed);
      traces.embedMs = Date.now() - startEmbed;

      await sendEvent("status", "retrieving");
      const startRetrieve = Date.now();
      const store = new JsonVectorStore(config.dataDir, libraryId);
      await store.load();

      const manifest = await store.loadManifest();
      if (!manifest) {
        throw new Error(
          `Library not found: ${libraryId}. Re-ingest with \`pnpm ingest --library ${libraryId} --path <folder>\` or pick a different library.`,
        );
      }
      if (manifest.embeddingModel !== config.embedModel) {
        throw new Error(
          `Embedding model mismatch! Library built with ${manifest.embeddingModel}, server running ${config.embedModel}. Please re-ingest.`,
        );
      }

      const docBoost = store.documentRouterBoosts(
        embedVec,
        config.retrieveDocRouterWeight,
      );
      const graphTypes = config.retrieveGraphEdgeTypes.filter(
        (t): t is GraphEdgeType =>
          typeof t === "string" &&
          [
            "defines",
            "references",
            "see_also",
            "parent_section",
            "prev_section",
            "next_section",
          ].includes(t),
      );

      const chunks = await store.retrieveWithNeighbors(
        embedVec,
        config.retrieveTopK,
        config.retrieveNeighborWindow,
        {
          question: questionTrimmed,
          queryTerms: retrievalTermsFromQuestion(questionTrimmed),
          candidatePool: config.retrieveCandidatePool,
          lexicalWeight: config.retrieveLexicalWeight,
          neighborExpandForTop: config.retrieveNeighborExpandTop,
          maxChunksPerDocument: config.retrieveMaxChunksPerDocument,
          indexHintWeight: config.retrieveIndexHintBoost,
          hybridLexicalTopK: config.retrieveHybridLexicalTopK,
          documentBoost: docBoost.size > 0 ? docBoost : undefined,
          graphSeedCount: config.retrieveGraphSeedCount,
          graphExpandPerSeed: config.retrieveGraphExpandPerHit,
          graphExpandWeight: config.retrieveGraphExpandWeight,
          graphEdgeTypes: graphTypes,
          defineConceptBoostWeight: config.retrieveDefineConceptWeight,
          defineConceptMaxChunks: config.retrieveDefineConceptMaxChunks,
        },
      );
      const defineConceptRetrieveDebug = store.getDefineConceptRetrieveDebug();
      traces.retrieveMs = Date.now() - startRetrieve;

      await sendEvent("status", "generating");
      const startGen = Date.now();
      const { output, chunksInPrompt } = await generateAnswer(
        libraryId,
        questionTrimmed,
        chunks,
        history,
      );
      traces.generateMs = Date.now() - startGen;

      const result = await formatResult(
        libraryId,
        output,
        traces,
        chunksInPrompt,
        questionTrimmed,
        defineConceptRetrieveDebug,
      );

      if (result.attributionDebug) {
        console.log("[query][attribution]", {
          resolvedModelCorpusMatches:
            result.attributionDebug.resolvedCitationIds,
          finalCitationChunkIds: result.attributionDebug.finalCitationChunkIds,
          unresolvedModel: result.attributionDebug.unresolvedModelChunkIds,
          promptContextDropped:
            result.attributionDebug.promptContextDroppedCitationIds,
          usedFallback: result.attributionDebug.usedProvenanceFallback,
          fallbackIds: result.attributionDebug.fallbackCitationIds,
          stackingSupplement:
            result.attributionDebug.stackingCitationSupplementIds,
          prunedIrrelevant: result.attributionDebug.prunedIrrelevantCitationIds,
          answerAlignmentScores:
            result.attributionDebug.answerCitationAlignmentScores,
          weakSupportPruned:
            result.attributionDebug.weakSupportPrunedCitationIds,
          promptOrder: result.attributionDebug.promptChunkSummaries.map(
            (s) =>
              `#${s.order} ${s.chunkId}${s.sectionHeading ? ` (${s.sectionHeading.slice(0, 60)})` : ""}`,
          ),
        });
      }

      await sendEvent("result", result);
      await sendEvent("done");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      await sendEvent("error", { message });
      await sendEvent("done");
    } finally {
      await writer.close();
    }
  })();

  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
