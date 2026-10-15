import "dotenv/config";
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
  MAX_FILE_KB: z.coerce.number().positive().default(1024),
  MAX_FILES_PER_SOURCE: z.coerce.number().int().positive().default(5000),
  ALLOWED_GIT_HOSTS: csv("github.com,gitlab.com,bitbucket.org,dev.azure.com"),
  QUERY_TOP_K: z.coerce.number().int().positive().max(50).default(8),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // Print only which variables are wrong -- never their values.
  const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
  console.error(`Invalid environment configuration:\n${problems}`);
  process.exit(1);
}
const env = parsed.data;

export const config = {
  port: env.PORT,
  corsOrigins: env.CORS_ORIGIN,

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
    maxFilesPerSource: env.MAX_FILES_PER_SOURCE,
  },

  git: {
    allowedHosts: env.ALLOWED_GIT_HOSTS.map((h) => h.toLowerCase()),
  },

  query: {
    topK: env.QUERY_TOP_K,
  },

  /**
   * Chunking profiles per content type (sizes in tokens).
   * Starting values based on common practice (Azure AI Search guidance: ~512 tokens, ~25% overlap
   * for prose; code split by structure with no overlap). Tune against your own questions.
   * Bump `version` whenever you change a profile so changed chunks are re-embedded.
   */
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
