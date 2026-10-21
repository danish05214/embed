import { config } from "../config.js";
import { logger } from "../utils/logger.js";

/**
 * Local cross-encoder re-ranker (default: BGE Reranker v2-m3, Apache 2.0, via Transformers.js).
 *
 * Vector search compares the question and each chunk separately. A cross-encoder reads the
 * question and one chunk together and returns a relevance score (0..1), which is much more
 * accurate, but too slow to run on the whole index; so it only re-scores the search shortlist.
 *
 * Everything runs in this process on the CPU; no question or chunk text leaves the server.
 * The model (~570 MB for q8) is downloaded once from Hugging Face into RERANK_CACHE_DIR.
 * If the model cannot be loaded or is too slow, callers fall back to the search order.
 */

type Scorer = (query: string, documents: string[]) => Promise<number[]>;

export type RerankerStatus = "disabled" | "idle" | "loading" | "ready" | "failed";

let status: RerankerStatus = config.rerank.enabled ? "idle" : "disabled";
let loading: Promise<Scorer | null> | null = null;

export function rerankerStatus(): RerankerStatus {
  return status;
}

async function loadScorer(): Promise<Scorer | null> {
  const started = Date.now();
  status = "loading";
  try {
    // Imported lazily: the package is large and only needed when re-ranking is on.
    const hf = await import("@huggingface/transformers");
    hf.env.cacheDir = config.rerank.cacheDir;
    hf.env.allowLocalModels = false; // load by Hugging Face ID (from cache or download), not from a local path
    hf.env.allowRemoteModels = config.rerank.allowDownload;

    const opts = { revision: config.rerank.revision };
    const tokenizer = await hf.AutoTokenizer.from_pretrained(
      config.rerank.model,
      opts,
    );
    const model = await hf.AutoModelForSequenceClassification.from_pretrained(
      config.rerank.model,
      { ...opts, dtype: config.rerank.dtype },
    );

    const scorer: Scorer = async (query, documents) => {
      const scores: number[] = [];
      for (let i = 0; i < documents.length; i += config.rerank.batchSize) {
        const batch = documents.slice(i, i + config.rerank.batchSize);
        const inputs = tokenizer(new Array(batch.length).fill(query), {
          text_pair: batch,
          padding: true,
          truncation: true,
          max_length: config.rerank.maxTokens,
        });
        const { logits } = await model(inputs);
        const rows = logits.sigmoid().tolist() as number[][];
        for (const r of rows) scores.push(Number(r[0]));
      }
      return scores;
    };

    status = "ready";
    logger.info("Re-ranker ready", {
      model: config.rerank.model,
      dtype: config.rerank.dtype,
      loadMs: Date.now() - started,
    });
    return scorer;
  } catch (err) {
    status = "failed";
    logger.error(
      "Re-ranker could not be loaded; answers will use the search order",
      {
        model: config.rerank.model,
        error: (err as Error).message,
        hint: config.rerank.allowDownload
          ? "Check that @huggingface/transformers is installed and huggingface.co is reachable"
          : "RERANK_ALLOW_DOWNLOAD=false: the model must already be in RERANK_CACHE_DIR",
      },
    );
    return null;
  }
}

function getScorer(): Promise<Scorer | null> {
  if (!config.rerank.enabled) return Promise.resolve(null);
  loading ??= loadScorer();
  return loading;
}

/** Start loading the model in the background (called at server start-up). */
export function warmUpReranker(): void {
  if (config.rerank.enabled) void getScorer();
}

/**
 * Relevance score (0..1) for each document, in the same order, or null when re-ranking is
 * disabled, still loading, failed to load, errored or timed out. Never throws.
 */
export async function rerank(
  query: string,
  documents: string[],
): Promise<number[] | null> {
  if (!config.rerank.enabled || documents.length === 0) return null;
  // Do not make the first questions wait for a ~570 MB download: use the search order meanwhile.
  if (status !== "ready") {
    void getScorer();
    if (status === "loading" || status === "idle")
      logger.info("Re-ranker still loading; using search order for this question");
    return null;
  }
  const scorer = await getScorer();
  if (!scorer) return null;

  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), config.rerank.timeoutMs);
    });
    const scores = await Promise.race([scorer(query, documents), timeout]);
    if (!scores) {
      logger.warn("Re-ranking timed out; using search order", {
        documents: documents.length,
        timeoutMs: config.rerank.timeoutMs,
      });
      return null;
    }
    logger.info("Re-ranked candidates", {
      documents: documents.length,
      ms: Date.now() - started,
    });
    return scores;
  } catch (err) {
    logger.warn("Re-ranking failed; using search order", {
      error: (err as Error).message,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}
