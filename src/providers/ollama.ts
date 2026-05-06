import type { z } from "zod";
import { config } from "../config";
import {
  countTokens as gptCount,
  truncateToTokens as gptTruncate,
} from "../lib/tokens";
import type { Provider } from "./types";

export class OllamaProvider implements Provider {
  private baseUrl: string;
  private llmModel: string;
  private embedModel: string;

  constructor() {
    this.baseUrl = config.ollamaBaseUrl;
    this.llmModel = config.llmModel;
    this.embedModel = config.embedModel;
  }

  countTokens(text: string): number {
    // Ollama models (Nomic/Llama) are less efficient than GPT tokenizers.
    // We apply a safe 1.5x multiplier to the GPT token count to approximate them.
    return Math.ceil(gptCount(text) * 1.5);
  }

  truncateToTokens(text: string, maxTokens: number): string {
    const gptTarget = Math.floor(maxTokens / 1.5);
    return gptTruncate(text, gptTarget);
  }

  async embed(text: string): Promise<number[]> {
    // Sanitize null characters that sometimes come from PDF extraction and crash Ollama
    const sanitizedText = text.replace(/\0/g, "");

    // Nomic has a hard limit of 2048 tokens in Ollama.
    // We clamp to 1000 of our estimated tokens, and apply a draconian 2000 character hard slice to survive PDF OCR artifacts that contain no spaces.
    let safeText = this.truncateToTokens(sanitizedText, 1000);
    if (safeText.length > 2000) {
      safeText = safeText.substring(0, 2000);
    }

    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.embedModel,
        prompt: safeText,
        options: { num_ctx: 8192 },
      }),
    });
    if (!res.ok) {
      const errorText = await res.text();
      console.error(`\n[FATAL] Ollama embed failed on a chunk!`);
      console.error(`  - Original length (chars): ${text.length}`);
      console.error(`  - Sanitized length (chars): ${sanitizedText.length}`);
      console.error(`  - Truncated length (chars): ${safeText.length}`);
      console.error(
        `  - Estimated Provider Tokens: ${this.countTokens(safeText)}`,
      );
      console.error(
        `  - Truncated snippet (first 200 chars): ${safeText.substring(0, 200)}...`,
      );
      throw new Error(`Ollama embed failed: ${res.statusText} - ${errorText}`);
    }
    const data = await res.json();
    return data.embedding;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const safeTexts = texts.map((text) => {
      const sanitizedText = text.replace(/\0/g, "");
      let safeText = this.truncateToTokens(sanitizedText, 1000);
      if (safeText.length > 2000) safeText = safeText.substring(0, 2000);
      return safeText;
    });

    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.embedModel,
        input: safeTexts,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error(`\n[FATAL] Ollama embedBatch failed!`);
      throw new Error(
        `Ollama embedBatch failed: ${res.statusText} - ${errorText}`,
      );
    }
    const data = await res.json();
    return data.embeddings;
  }

  async generateStructured<T extends z.ZodType>(
    prompt: string,
    schema: T,
  ): Promise<z.infer<T>> {
    console.log(
      `\n[Ollama] generateStructured start - Prompt length: ${prompt.length} chars`,
    );
    const start = Date.now();

    // For qwen2.5/llama3.1, Ollama supports `format: "json"`
    // Ask for strictly matching schema in the prompt
    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.llmModel,
        prompt: prompt,
        format: "json",
        stream: false,
      }),
    });

    console.log(
      `[Ollama] generateStructured fetch completed in ${Date.now() - start}ms - Status: ${res.status}`,
    );

    if (!res.ok) {
      throw new Error(`Ollama generate failed: ${res.statusText}`);
    }
    const data = await res.json();
    console.log(
      `[Ollama] generateStructured raw output length: ${data.response?.length || 0}`,
    );
    try {
      const parsedPreview = JSON.parse(data.response ?? "{}") as {
        citedChunkIds?: string[];
      };
      if (parsedPreview.citedChunkIds?.length) {
        console.log(
          "[Ollama] model citedChunkIds:",
          parsedPreview.citedChunkIds,
        );
      } else {
        console.log("[Ollama] model citedChunkIds: (empty / missing)");
      }
    } catch {
      /* ignore parse preview */
    }

    try {
      return schema.parse(JSON.parse(data.response));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[Ollama] JSON parsing/validation failed on raw output:\n${data.response}`,
      );
      throw new Error(`LLM output validation failed: ${msg}`);
    }
  }
}

export const provider = new OllamaProvider();
