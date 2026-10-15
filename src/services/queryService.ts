import { config } from "../config.js";
import { complete } from "../llm/chat.js";
import { embedQuery } from "../llm/embeddings.js";
import { ANSWER_SYSTEM_PROMPT, buildUserPrompt } from "../llm/prompts.js";
import { chunkRepository } from "../repository/chunkRepository.js";
import type { SearchHit } from "../types.js";

export interface QuerySource {
  ref: number;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  path: string;
  label?: string;
  startLine?: number;
  endLine?: number;
  url: string | null;
  score: number;
  snippet: string;
}

export interface QueryResult {
  answer: string;
  sources: QuerySource[];
  usage?: { promptTokens: number; completionTokens: number };
}

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
  const hits = await chunkRepository.hybridSearch({
    embedding,
    queryText: input.question,
    topK,
    sourceIds: input.sourceIds,
  });

  if (hits.length === 0) {
    return {
      answer:
        "I couldn't find anything relevant in the indexed sources. Try rephrasing, or check that the right repo/documents are indexed.",
      sources: [],
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
      path: h.path,
      label: h.metadata.label,
      startLine: h.metadata.startLine,
      endLine: h.metadata.endLine,
      url: deepLink(h),
      score: Number(h.score.toFixed(4)),
      snippet:
        h.content.length > 400 ? `${h.content.slice(0, 400)}…` : h.content,
    })),
    usage,
  };
}
