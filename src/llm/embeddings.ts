import { config } from "../config.js";
import { openai } from "./client.js";

const MAX_INPUTS_PER_REQUEST = 64;
const MAX_TOKENS_PER_REQUEST = 200_000; // stay well below the API's per-request token limit

export const EMBEDDING_MODEL = config.azureOpenAI.embeddingDeployment;

/** Embed many texts in batches. Returns vectors in the same order as `texts`. */
export async function embedTexts(texts: string[], tokenCounts?: number[]): Promise<number[][]> {
  const results: number[][] = new Array(texts.length);
  let batch: number[] = [];
  let batchTokens = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    const idx = batch;
    batch = [];
    batchTokens = 0;
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: idx.map((i) => texts[i]!),
    });
    for (const item of res.data) {
      const vec = item.embedding as number[];
      if (vec.length !== config.azureOpenAI.embeddingDimensions) {
        throw new Error(
          `Embedding has ${vec.length} dimensions but EMBEDDING_DIMENSIONS=${config.azureOpenAI.embeddingDimensions}. ` +
            "Update .env and the vector(N) size in the SQL migration to match the model.",
        );
      }
      results[idx[item.index]!] = vec;
    }
  };

  for (let i = 0; i < texts.length; i++) {
    const t = tokenCounts?.[i] ?? Math.ceil(texts[i]!.length / 4);
    if (batch.length >= MAX_INPUTS_PER_REQUEST || batchTokens + t > MAX_TOKENS_PER_REQUEST) await flush();
    batch.push(i);
    batchTokens += t;
  }
  await flush();
  return results;
}

export async function embedQuery(text: string): Promise<number[]> {
  const [vec] = await embedTexts([text]);
  return vec!;
}
