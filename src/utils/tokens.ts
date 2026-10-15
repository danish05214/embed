import { getEncoding, type Tiktoken } from "js-tiktoken";

// text-embedding-3-* and gpt-4.1 both work well with cl100k_base for size estimates.
let encoder: Tiktoken | null = null;

function enc(): Tiktoken {
  if (!encoder) encoder = getEncoding("cl100k_base");
  return encoder;
}

export function countTokens(text: string): number {
  return enc().encode(text).length;
}

/** Hard cap: truncate to at most `maxTokens` tokens. */
export function truncateToTokens(text: string, maxTokens: number): string {
  const ids = enc().encode(text);
  if (ids.length <= maxTokens) return text;
  return enc().decode(ids.slice(0, maxTokens));
}
