# Project status

**Last updated:** 2026-05-27

## Paused

Active development on **rules-lawyer** is paused. Chris is shifting focus to [Greenskin Labs](www.greenskinlabs.com) and the **Rules Q&A** feature.

## What carries forward

This repo remains the local-first proof-of-concept for patterns Greenskin Labs will productionize:

- Structured JSON generation with **server-side citation hydration** (model emits chunk IDs only)
- **Hybrid retrieval** — dense embeddings plus full-corpus lexical reranking
- Ingest-time **zettels, concept enrichment, MOC summaries, and link graph** (query-time graph/MOC boosts are off by default; see `src/config.ts`)
- **Honest abstention** (`not_in_book`) and a small **eval harness** for generation behavior

Greenskin Labs replaces the local JSON store with Supabase/pgvector, swaps Ollama for Groq via Cloudflare AI Gateway, and uses Google Document AI for OCR-heavy wargame PDFs — but the RAG contract (retrieve → generate → validate citations) started here.

## Resuming later

When work resumes, start from `README.md` (kept in sync with the code), run `pnpm ingest` against a test library, then `pnpm eval` with Ollama running.
