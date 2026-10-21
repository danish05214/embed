import "dotenv/config";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

const bool = z
  .string()
  .optional()
  .transform((v) => (v ?? "").toLowerCase() === "true");

const csv = (fallback: string) =>
  z
    .string()
    .optional()
    .transform((v) =>
      (v && v.trim() ? v : fallback)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    );

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PGSSL: bool,
  PG_SSL_CA_PATH: z.string().optional(),

  AZURE_OPENAI_ENDPOINT: z.string().url("AZURE_OPENAI_ENDPOINT must be a URL"),
  AZURE_OPENAI_API_KEY: z.string().min(1, "AZURE_OPENAI_API_KEY is required"),
  AZURE_OPENAI_LLM_DEPLOYMENT: z.string().min(1),
  AZURE_OPENAI_EMBEDDING_DEPLOYMENT: z.string().min(1),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGIN: csv("http://localhost:5173"),

  MAX_UPLOAD_MB: z.coerce.number().positive().default(50),
  MAX_FILE_KB: z.coerce.number().positive().default(1024), // code / plain-text files
  MAX_DOC_FILE_MB: z.coerce.number().positive().default(25), // pdf, docx, pptx, xlsx
  MAX_FILES_PER_SOURCE: z.coerce.number().int().positive().default(5000),
  ALLOWED_GIT_HOSTS: csv("github.com,gitlab.com,bitbucket.org,dev.azure.com"),
  QUERY_TOP_K: z.coerce.number().int().positive().max(50).default(8),

  // Re-ranking: a local cross-encoder (BGE Reranker v2-m3, Apache 2.0) re-scores the search
  // candidates against the question. Runs on this machine; no data leaves the server.
  RERANK_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  RERANK_MODEL: z.string().min(1).default("onnx-community/bge-reranker-v2-m3-ONNX"),
  // Pinned Hugging Face commit so the downloaded model cannot change underneath us.
  RERANK_MODEL_REVISION: z.string().min(1).default("6f5ff65298512715a1e669753bc754d2bc8f367b"),
  // q8 = int8 quantized (~570 MB, fastest on CPU). fp32 is ~2.3 GB.
  RERANK_DTYPE: z.enum(["q8", "int8", "uint8", "fp16", "fp32", "q4"]).default("q8"),
  // Default: <user home>/.cache/cs-embed/models (outside the project, so OneDrive/git don't sync ~570 MB)
  RERANK_CACHE_DIR: z.string().optional(),
  // false = only load from RERANK_CACHE_DIR (pre-downloaded), never contact huggingface.co
  RERANK_ALLOW_DOWNLOAD: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
  RERANK_CANDIDATES: z.coerce.number().int().positive().max(100).default(30),
  RERANK_MIN_SCORE: z.coerce.number().min(0).max(1).default(0),
  RERANK_MAX_TOKENS: z.coerce.number().int().positive().max(8192).default(1024),
  RERANK_BATCH_SIZE: z.coerce.number().int().positive().max(64).default(8),
  RERANK_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),

  // Swagger UI at /api/docs. Defaults to on; set ENABLE_API_DOCS=false to hide it (e.g. in production).
  ENABLE_API_DOCS: z
    .string()
    .optional()
    .transform((v) => (v ?? "true").toLowerCase() !== "false"),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}
const env = parsed.data;

export const config = {
  port: env.PORT,
  corsOrigins: env.CORS_ORIGIN,
  apiDocsEnabled: env.ENABLE_API_DOCS,

  db: {
    url: env.DATABASE_URL,
    ssl: env.PGSSL,
    sslCaPath: env.PG_SSL_CA_PATH || undefined,
  },

  azureOpenAI: {
    endpoint: env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, ""),
    apiKey: env.AZURE_OPENAI_API_KEY,
    llmDeployment: env.AZURE_OPENAI_LLM_DEPLOYMENT,
    embeddingDeployment: env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT,
    embeddingDimensions: env.EMBEDDING_DIMENSIONS,
  },

  limits: {
    maxUploadBytes: env.MAX_UPLOAD_MB * 1024 * 1024,
    maxFileBytes: env.MAX_FILE_KB * 1024,
    maxDocFileBytes: env.MAX_DOC_FILE_MB * 1024 * 1024,
    maxFilesPerSource: env.MAX_FILES_PER_SOURCE,
  },

  git: {
    allowedHosts: env.ALLOWED_GIT_HOSTS.map((h) => h.toLowerCase()),
  },

  query: {
    topK: env.QUERY_TOP_K,
  },

  rerank: {
    enabled: env.RERANK_ENABLED,
    model: env.RERANK_MODEL,
    revision: env.RERANK_MODEL_REVISION,
    dtype: env.RERANK_DTYPE,
    cacheDir: path.resolve(
      env.RERANK_CACHE_DIR?.trim() ||
        path.join(os.homedir(), ".cache", "cs-embed", "models"),
    ),
    allowDownload: env.RERANK_ALLOW_DOWNLOAD,
    candidates: env.RERANK_CANDIDATES,
    minScore: env.RERANK_MIN_SCORE,
    maxTokens: env.RERANK_MAX_TOKENS,
    batchSize: env.RERANK_BATCH_SIZE,
    timeoutMs: env.RERANK_TIMEOUT_MS,
  },

  chunking: {
    version: 1,
    profiles: {
      code: { chunkSize: 800, overlap: 0 },
      markdown: { chunkSize: 512, overlap: 64 },
      text: { chunkSize: 512, overlap: 96 },
      table: { chunkSize: 1000, overlap: 0 },
    },
  },
} as const;

export type AppConfig = typeof config;
