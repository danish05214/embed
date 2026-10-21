import { config } from "../config.js";
import { complete } from "../llm/chat.js";
import { embedQuery } from "../llm/embeddings.js";
import { ANSWER_SYSTEM_PROMPT, buildUserPrompt } from "../llm/prompts.js";
import { rerank } from "../llm/reranker.js";
import { chunkRepository } from "../repository/chunkRepository.js";
import type { QueryResult } from "../schemas/query.js";
import type { SearchHit } from "../types.js";

export type { QueryResult, QuerySource } from "../schemas/query.js";

/** Deep link to the exact file/lines at the indexed commit (GitHub/GitLab); repo URL otherwise. */
function deepLink(hit: SearchHit): string | null {
  if (hit.sourceType !== "git" || !hit.repoUrl) return null;
  const base = hit.repoUrl.replace(/\.git$/, "");
  const ref = hit.commitSha ?? hit.branch ?? "HEAD";
  const filePath = hit.path.split("/").map(encodeURIComponent).join("/");
  const { startLine: s, endLine: e } = hit.metadata;
  if (base.startsWith("https://github.com/")) {
    return `${base}/blob/${ref}/${filePath}${s ? `#L${s}-L${e ?? s}` : ""}`;
  }
  if (base.startsWith("https://gitlab.com/")) {
    return `${base}/-/blob/${ref}/${filePath}${s ? `#L${s}-${e ?? s}` : ""}`;
  }
  return base;
}

export async function answerQuestion(input: {
  question: string;
  sourceIds?: string[];
  topK?: number;
}): Promise<QueryResult> {
  const topK = input.topK ?? config.query.topK;
  const embedding = await embedQuery(input.question);

  // Stage 1: hybrid search casts a wide net (more candidates than we will use).
  const candidates = await chunkRepository.hybridSearch({
    embedding,
    queryText: input.question,
    topK: config.rerank.enabled
      ? Math.max(topK, config.rerank.candidates)
      : topK,
    sourceIds: input.sourceIds,
  });

  // Stage 2: the cross-encoder re-scores each (question, chunk) pair; keep the best topK.
  // Falls back to the search order if re-ranking is off, still loading, or fails.
  const scores = await rerank(
    input.question,
    candidates.map((h) => rerankText(h)),
  );
  const reranked = scores !== null;
  let hits: (SearchHit & { rerankScore?: number })[] = candidates;
  if (scores) {
    hits = candidates
      .map((h, i) => ({ ...h, rerankScore: scores[i]! }))
      .sort((a, b) => b.rerankScore - a.rerankScore)
      .filter((h) => h.rerankScore >= config.rerank.minScore);
  }
  hits = hits.slice(0, topK);

  if (hits.length === 0) {
    return {
      answer:
        "I couldn't find anything relevant in the indexed sources. Try rephrasing, or check that the right repo/documents are indexed.",
      sources: [],
      reranked,
    };
  }

  const { text, usage } = await complete([
    { role: "system", content: ANSWER_SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input.question, hits) },
  ]);

  return {
    answer: text,
    sources: hits.map((h, i) => ({
      ref: i + 1,
      sourceId: h.sourceId,
      sourceName: h.sourceName,
      sourceType: h.sourceType,
      branches: h.branches,
      path: h.path,
      label: h.metadata.label,
      startLine: h.metadata.startLine,
      endLine: h.metadata.endLine,
      url: deepLink(h),
      score: Number(h.score.toFixed(4)),
      rerankScore:
        h.rerankScore === undefined ? null : Number(h.rerankScore.toFixed(4)),
      snippet:
        h.content.length > 400 ? `${h.content.slice(0, 400)}…` : h.content,
    })),
    usage,
    reranked,
  };
}

/** What the re-ranker reads for a chunk: file path (and section label) help it judge relevance. */
function rerankText(hit: SearchHit): string {
  const label = hit.metadata.label ? ` | ${hit.metadata.label}` : "";
  return `File: ${hit.path}${label}\n${hit.content}`;
}
