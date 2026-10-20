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
  MAX_FILE_KB: z.coerce.number().positive().default(1024), // code / plain-text files
  MAX_DOC_FILE_MB: z.coerce.number().positive().default(25), // pdf, docx, pptx, xlsx
  MAX_FILES_PER_SOURCE: z.coerce.number().int().positive().default(5000),
  ALLOWED_GIT_HOSTS: csv("github.com,gitlab.com,bitbucket.org,dev.azure.com"),
  QUERY_TOP_K: z.coerce.number().int().positive().max(50).default(8),
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
