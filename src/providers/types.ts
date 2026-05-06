import { z } from "zod";

export interface Provider {
  embed(text: string): Promise<number[]>;
  embedBatch?(texts: string[]): Promise<number[][]>;
  generateStructured<T extends z.ZodType>(prompt: string, schema: T): Promise<z.infer<T>>;
  countTokens(text: string): number;
  truncateToTokens(text: string, maxTokens: number): string;
}
