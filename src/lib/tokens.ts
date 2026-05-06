import { encode, decode } from "gpt-tokenizer";

export function countTokens(text: string): number {
  return encode(text).length;
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const tokens = encode(text);
  if (tokens.length <= maxTokens) return text;
  return decode(tokens.slice(0, maxTokens));
}
