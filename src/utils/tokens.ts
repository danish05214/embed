import { getEncoding, type Tiktoken } from "js-tiktoken";

let encoder: Tiktoken | null = null;

function enc(): Tiktoken {
  if (!encoder) encoder = getEncoding("cl100k_base");
  return encoder;
}

export function countTokens(text: string): number {
  return enc().encode(text).length;
}

export function truncateToTokens(text: string, maxTokens: number): string {
  const ids = enc().encode(text);
  if (ids.length <= maxTokens) return text;
  return enc().decode(ids.slice(0, maxTokens));
}
