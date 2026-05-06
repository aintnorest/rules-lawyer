import path from "node:path";
import fg from "fast-glob";
import { config } from "../src/config";
import { buildEdgesForLibrary } from "../src/ingest/build-edges";
import { chunkDocument } from "../src/ingest/chunk";
import { getFileHash } from "../src/ingest/hash";
import { extractIndexHintsFromPages } from "../src/ingest/index-extract";
import { enrichZettelsWithLlM } from "../src/ingest/llm-enrich";
import { buildDocumentMocs } from "../src/ingest/moc";
import { embedMocSummaries } from "../src/ingest/moc-embed";
import { UnpdfParser } from "../src/ingest/parsers/unpdf";
import { JsonVectorStore } from "../src/ingest/store";
import {
  ENRICH_PROMPT_VERSION,
  GRAPH_VERSION,
  zettelizeLibrary,
} from "../src/ingest/zettelize";
import { chunkTextWithHeading } from "../src/lib/chunk-text";
import { toSlug } from "../src/lib/slug";
import { provider } from "../src/providers/ollama";
import type { DocumentMoc, GraphEdge, Zettel } from "../src/types";

async function run() {
  const args = process.argv.slice(2);
  const rebuild = args.includes("--rebuild");
  const runAll = args.includes("--all");
  const noIndex = args.includes("--no-index");

  const libraryFilter = args.includes("--library")
    ? args[args.indexOf("--library") + 1]
    : null;
  const pathOverride = args.includes("--path")
    ? args[args.indexOf("--path") + 1]
    : null;

  let librariesToProcess = [...config.libraries];

  if (!runAll && libraryFilter && pathOverride) {
    librariesToProcess = [
      { id: libraryFilter, path: pathOverride, label: libraryFilter },
    ];
  } else if (!runAll) {
    console.error(
      "Usage: pnpm ingest --library <slug> --path <folder> [--rebuild] [--no-index] OR pnpm ingest --all [--no-index]",
    );
    process.exit(1);
  }

  const parser = new UnpdfParser();

  for (const lib of librariesToProcess) {
    const libId = lib.id || toSlug(lib.path);
    console.log(`\n=== Processing library: ${libId} ===`);

    const store = new JsonVectorStore(config.dataDir, libId);
    await store.init();

    let manifest = await store.loadManifest();
    if (!manifest || rebuild) {
      manifest = {
        id: libId,
        label: lib.label || libId,
        sourcePath: lib.path,
        embeddingProvider: "ollama",
        embeddingModel: config.embedModel,
        embeddingDimensions: 768, // Hardcoded for nomic-embed-text for now
        chunkParams: { targetTokens: 300, overlapTokens: 40 },
        documents: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    // Force safety override for existing manifests that were created with 700 limits
    manifest.chunkParams = { targetTokens: 300, overlapTokens: 40 };

    const searchPath = lib.path.endsWith(".pdf")
      ? lib.path
      : path.join(lib.path, "**/*.pdf");
    const files = await fg(searchPath, { absolute: true });

    const allChunks = [];
    const allVectors = [];
    let chunksModified = false;

    // For simplicity in MVP, if any file changes, we just re-process everything
    // to keep the chunk.jsonl and vectors.bin array perfectly in sync without complex merging logic.
    const anyChanged = files.some((file) => {
      const fileName = path.basename(file);
      const docId = toSlug(fileName);
      const hash = getFileHash(file);
      const existingDoc = manifest?.documents.find((d) => d.id === docId);
      return !(existingDoc && existingDoc.sha256 === hash);
    });

    if (!anyChanged && !rebuild) {
      console.log("No changes detected in library. Skipping.");
      continue;
    }

    manifest.documents = []; // reset documents

    const indexByDocument: Record<string, Record<string, number[]>> = {};

    for (const file of files) {
      const fileName = path.basename(file);
      const docId = toSlug(fileName);
      const hash = getFileHash(file);

      console.log(`Parsing ${fileName}...`);
      const parsedDoc = await parser.parse(file);

      if (!noIndex) {
        const { entries, usedIndexHeading } = extractIndexHintsFromPages(
          parsedDoc.pages,
        );
        const n = Object.keys(entries).length;
        if (n > 0) {
          indexByDocument[docId] = entries;
          console.log(
            `  Index hints: ${n} entries (${usedIndexHeading ? "heading found" : "heuristic tail"})`,
          );
        } else {
          console.log(
            `  Index hints: skipped (no confident index — add manual index-hints.json if needed)`,
          );
        }
      }

      console.log(`Chunking ${fileName}...`);
      const docChunks = chunkDocument(
        provider,
        docId,
        libId,
        parsedDoc.pages,
        manifest.chunkParams.targetTokens,
        manifest.chunkParams.overlapTokens,
      );

      console.log(`Embedding ${docChunks.length} chunks for ${fileName}...`);
      const docVectors: number[][] = [];

      if (provider.embedBatch) {
        const batchSize = 100;
        for (let i = 0; i < docChunks.length; i += batchSize) {
          const batch = docChunks.slice(i, i + batchSize);
          process.stdout.write(
            `Embedding batch ${i + 1} to ${Math.min(i + batchSize, docChunks.length)} of ${docChunks.length}\r`,
          );
          const vecs = await provider.embedBatch(
            batch.map((c) => chunkTextWithHeading(c)),
          );
          docVectors.push(...vecs);
        }
      } else {
        for (let i = 0; i < docChunks.length; i++) {
          process.stdout.write(
            `Embedding chunk ${i + 1}/${docChunks.length}\r`,
          );
          const vec = await provider.embed(chunkTextWithHeading(docChunks[i]));
          docVectors.push(vec);
        }
      }
      console.log(`\nFinished embedding ${fileName}.`);

      const startIdx = allChunks.length;
      allChunks.push(...docChunks);
      allVectors.push(...docVectors);

      manifest.documents.push({
        id: docId,
        label: fileName,
        sha256: hash,
        pageCount: parsedDoc.pages.length,
        chunkRange: [startIdx, allChunks.length - 1] as [number, number],
      });
      chunksModified = true;
    }

    if (chunksModified) {
      manifest.updatedAt = new Date().toISOString();

      const libraryDir = path.join(config.dataDir, libId);
      let zettels: Zettel[] = [];
      let zVectors: number[][] = [];
      let edges: GraphEdge[] = [];
      let mocs: DocumentMoc[] = [];
      let mVectors: number[][] = [];

      if (allChunks.length > 0) {
        console.log(`Zettelizing ${allChunks.length} chunks → sections…`);
        zettels = zettelizeLibrary(provider, allChunks, libId);
        zVectors = [];
        if (provider.embedBatch) {
          const zb = 100;
          for (let i = 0; i < zettels.length; i += zb) {
            const batch = zettels.slice(i, i + zb);
            process.stdout.write(
              `\rEmbedding zettels ${Math.min(i + zb, zettels.length)}/${zettels.length}`,
            );
            const vecs = await provider.embedBatch(
              batch.map((z) => z.synopsis),
            );
            zVectors.push(...vecs);
          }
          console.log("");
        } else {
          for (let i = 0; i < zettels.length; i++) {
            process.stdout.write(
              `\rEmbedding zettels ${i + 1}/${zettels.length}`,
            );
            const zz = zettels[i];
            if (zz) zVectors.push(await provider.embed(zz.synopsis));
          }
          console.log("");
        }

        await enrichZettelsWithLlM(provider, zettels, libraryDir);
        edges = buildEdgesForLibrary(zettels);
        mocs = await buildDocumentMocs(provider, zettels, manifest);
        mVectors = await embedMocSummaries(
          provider,
          mocs.map((m) => m.scopeSummary),
        );

        manifest.graph = {
          version: GRAPH_VERSION,
          enrichPromptVersion: ENRICH_PROMPT_VERSION,
          zettelCount: zettels.length,
          edgeCount: edges.length,
          mocCount: mocs.length,
          updatedAt: new Date().toISOString(),
        };
      } else {
        manifest.graph = {
          version: GRAPH_VERSION,
          enrichPromptVersion: ENRICH_PROMPT_VERSION,
          zettelCount: 0,
          edgeCount: 0,
          mocCount: 0,
          updatedAt: new Date().toISOString(),
        };
      }

      await store.saveChunks(allChunks, allVectors);
      if (allChunks.length > 0 && zettels.length > 0) {
        await store.saveZettels(zettels, zVectors);
        await store.saveEdges(edges);
        await store.saveMocs(mocs, mVectors);
      }
      await store.saveManifest(manifest);
      if (!noIndex) {
        if (Object.keys(indexByDocument).length > 0) {
          await store.saveIndexHints(indexByDocument);
          console.log(`Wrote index-hints.json for ${libId}`);
        } else {
          await store.removeIndexHintsFile();
        }
      }
      console.log(`Saved library ${libId} to ${config.dataDir}`);
    }
  }
}

run().catch(console.error);
