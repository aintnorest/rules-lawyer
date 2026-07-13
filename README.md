# rules-lawyer

Local **RAG assistant** for tabletop RPG rules: you point it at a folder or PDF of rulebooks on your machine, it builds a search index, and you ask natural-language questions with **answers tied to real citations** from the text.

This repository was a **proof-of-concept** you can clone and run at home. It is **local-first only** (no hosted demo here, no accounts). This was intended to test out several ideas at zero cost. After using this project to work through some ideas I started a more realistic project that can be found at greenskinlabs.com (Rules Q&A API and UI). That work has been going well and you can read about it here https://greenskinlabs.com/blog.

> **Status (2026-05-27):** Development is **paused** on this repo. See [`STATUS.md`](STATUS.md) for context and what carries forward to Greenskin Labs.

---

## About this project

This is a small but **production-shaped** retrieval + generation pipeline, not a thin “chat with PDF” demo.

**Grounded answers.** The model must reply in structured JSON: prose fields plus **only chunk identifiers** it used. The server then **hydrates** citation snippets, page hints, and labels from the index. The model never invents quoted rule text in the citation layer—no snippet hallucinations in the UI.

**Retrieval that behaves with real books.** Search combines **embedding similarity** over chunks with a **full-corpus lexical lane** (so “does it stack?” can still surface a paragraph whose wording doesn’t match the embedding of the question). Results are merged, reranked, and expanded with neighboring chunks for the top hits. Ingest also builds **zettels, concept tags, MOC summaries, and a link graph**; optional **graph routing, MOC document boosts, and definesConcept retrieval** are implemented but **off by default** (`retrieveGraphExpandWeight`, `retrieveDocRouterWeight`, and `retrieveDefineConceptWeight` are `0` in `src/config.ts` — tune them in `rules-lawyer.config.json` to experiment).

**Honest uncertainty.** The model can label confidence as grounded, mixed, absent from the indexed text, or speculative; thin retrieval is expected to produce “not in these rules” behavior rather than confident fiction.

**Typed, validated IO.** Config and model outputs are validated with **Zod**. The LLM provider is behind a small **TypeScript interface** (currently **Ollama**), so swapping backends is isolated from routes and ingest.

**Ingest pipeline.** PDFs are parsed with **unpdf** (text layer), split into chunks with metadata (document, page span, optional headings), embedded in batches, then optionally grouped into **section “zettels”** with extra embeddings, **LLM-assisted concept tags**, **per-document scope summaries (MOC)**, and a simple link graph—stored as plain files under `data/<libraryId>/` (see below).

**Operator UX.** The web UI streams **Server-Sent Events** so you see embedding → retrieval → generation phases. **Web Speech** (where the browser allows) provides **push-to-talk input** into the question field. The model also returns a `spokenSummary` field in the API response, but the UI does **not** read it aloud yet.

**Quality checks.** `pnpm eval` runs a small **generation regression harness** against a committed markdown fixture (`eval/fixtures/mini-rules.md`). It exercises structured output and abstention via `generateAnswer` with in-memory chunks — **not** the full ingest → retrieve → answer path. Run it with Ollama up and the same models as ingest.

**Corpus licensing.** This repo does **not** ship third-party rulebooks. The walkthrough below uses the **Dungeons & Dragons SRD** (Creative Commons **CC BY 4.0**). You download the official PDF yourself, index it locally, and keep attribution in line with the license. SRD is rules reference material—not the full commercial books.

---

## Run it on your computer

These steps assume a normal laptop or desktop (macOS, Windows, or Linux). You will install three things: **Node.js** (to run the app), **pnpm** (to install JavaScript dependencies), and **Ollama** (to run the embedding and chat models on your machine).

### 0. What you are installing (in plain language)

- **Node.js** — runs the Next.js server and ingest scripts.  
- **pnpm** — downloads the project’s libraries (`next`, `react`, etc.).  
- **Ollama** — runs AI models **on your computer**. After install, it runs as a small local service that this app talks to.

---

### 1. Install Node.js (version 20 or newer)

- Download the **LTS** installer from [nodejs.org](https://nodejs.org/) and run it.  
- Check it worked. Open a terminal (Terminal on Mac, PowerShell or Command Prompt on Windows) and run:

  ```bash
  node -v
  ```

  You should see `v20`, `v22`, or similar. If the command is not found, restart the terminal or your computer and try again.

---

### 2. Install pnpm

In the same terminal:

```bash
npm install -g pnpm
```

Check:

```bash
pnpm -v
```

---

### 3. Install Ollama

- Download from [ollama.com](https://ollama.com/) and install the app.  
- **Leave Ollama running** (it usually shows a menu bar icon on Mac). The app listens at `http://127.0.0.1:11434` by default.

Download the two models this project uses (one for “understanding” questions in the index, one for answering):

```bash
ollama pull qwen2.5:3b-instruct
ollama pull nomic-embed-text
```

The first download can take several minutes depending on your connection.

---

### 4. Get the project on your machine

Clone the repository and open the project folder. If this repo is only `rules-lawyer`, that folder is the project root. If it lives inside a larger repo, `cd` into `projects/rules-lawyer`.

Install dependencies:

```bash
pnpm install
```

---

### 5. Get the D&D SRD PDF (you do not get it from this repo)

1. Obtain the official **SRD CC v5.2.1** (or current) PDF from Wizards of the Coast’s **CC-licensed** distribution (for example via [D&D Beyond’s SRD hub](https://www.dndbeyond.com/srd)).  
2. Save it somewhere you can keep a **full path** to the file, e.g.  
   - Mac/Linux: `/Users/yourname/Downloads/SRD_CC_v5.2.1.pdf`  
   - Windows: `C:\Users\yourname\Downloads\SRD_CC_v5.2.1.pdf`  

You may use a **folder of PDFs** instead of a single file; the ingest command accepts either.

---

### 6. Tell the project where your PDF is (optional but handy)

Copy the example config and edit the path:

```bash
cp rules-lawyer.config.example.json rules-lawyer.config.json
```

Open `rules-lawyer.config.json` in a text editor and set `path` to your real PDF path (or folder). This file is **ignored by git** so your personal paths are not pushed to GitHub.

---

### 7. Build the search index (one-time, or after you change PDFs)

From the project folder:

```bash
pnpm ingest --library dnd-srd-5-2-1 --path "/full/path/to/SRD_CC_v5.2.1.pdf"
```

- Replace the path with yours. Use quotes if the path has spaces.  
- This can take **many minutes** on the first run (thousands of chunks embedded). Progress prints in the terminal.  
- Indexed data is written under **`data/dnd-srd-5-2-1/`**. That directory is **not** committed to git (it’s large and machine-specific).
- **`--rebuild`** — discard the existing manifest and re-ingest from scratch.
- **`--no-index`** — skip automatic index-hint extraction from PDF tail pages (use manual `index-hints.json` if needed).

If you defined several libraries in `rules-lawyer.config.json`, you can instead run:

```bash
pnpm ingest --all
```

---

### 8. Start the app

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser. Choose the **D&D SRD** library (or whatever you named it), ask a question, and check the citations.

---

### 9. Voice (optional)

- **Chrome / Edge:** speech often works out of the box over `http://localhost`.  
- **Other devices on your Wi‑Fi:** browsers usually require **HTTPS** for the microphone. Tools like [mkcert](https://github.com/FiloSottile/mkcert) can give your dev server a trusted local certificate—that’s an advanced step.  
- **Firefox:** you may need to enable Web Speech in `about:config` (see your browser’s docs).

---

### 10. Run the automated checks (optional)

```bash
pnpm eval
```

Uses the synthetic markdown fixture in `eval/fixtures/mini-rules.md` — not for gameplay, just to sanity-check generation and abstention with Ollama running.

---

## Troubleshooting

| What you see | What to try |
|--------------|-------------|
| Errors about **Ollama** or connection refused | Start Ollama from the app menu; confirm `ollama list` works in a terminal. |
| **Embedding model mismatch** | The index was built with a different embed model than the app expects. Re-run ingest, or set `EMBED_MODEL` to match what is recorded in `data/<libraryId>/manifest.json`. |
| Empty **library** list in the UI | Run ingest successfully so `data/<id>/manifest.json` exists. |
| Garbled **tables** in answers | Text is taken from the PDF text layer in reading order via **unpdf**; complex multi-column tables may still be messy. OCR/table-aware parsing is out of scope for this POC (Greenskin Labs uses Document AI instead). |

---

## Repository layout (short)

| Path | Role |
|------|------|
| `app/` | Next.js 16 UI and `/api/libraries`, `/api/query` (SSE). |
| `src/config.ts` | Zod-validated config (`rules-lawyer.config.json` + env overrides). |
| `src/types.ts` | Shared types (`QueryResult`, `Chunk`, `Zettel`, etc.). |
| `src/ingest/` | PDF parsing (**unpdf**), chunking, JSON vector store, zettel + graph + MOC pipeline. |
| `src/query/` | Hybrid retrieval, prompt, generation, citation hydration and alignment. |
| `src/providers/` | Ollama-backed embed + structured JSON generate. |
| `src/lib/` | Chunk text, concepts, similarity, token helpers. |
| `scripts/ingest.ts` | CLI: build or update `data/<libraryId>/`. |
| `scripts/eval.ts` | CLI: generation checks from `eval/cases.json`. |
| `eval/fixtures/mini-rules.md` | Synthetic rules text for eval (not a PDF). |
| `data/<libraryId>/` | Your indexes (**gitignored**). Typical files: `manifest.json`, `chunks.jsonl`, `vectors.bin`, `zettels.jsonl`, `zettel_vectors.bin`, `edges.jsonl`, `moc.jsonl`, `moc_vectors.bin`, optional `index-hints.json`. |

### Config knobs (optional)

Copy `rules-lawyer.config.example.json` and extend with any fields from `src/config.ts` — for example `retrieveHybridLexicalTopK`, `retrieveLexicalWeight`, or non-zero graph/MOC/defineConcept weights for experiments.
