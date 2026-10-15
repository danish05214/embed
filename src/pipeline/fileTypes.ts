import path from "node:path";
import type { SupportedTextSplitterLanguage } from "@langchain/textsplitters";
import type { ContentKind } from "../types.js";

export type ParserKind = "text" | "pdf" | "docx" | "xlsx" | "csv";

export interface FileTypeInfo {
  ext: string;
  parser: ParserKind;
  kind: ContentKind;
  language?: SupportedTextSplitterLanguage;
}

const CODE_LANG: Record<string, SupportedTextSplitterLanguage | undefined> = {
  ts: "js",
  tsx: "js",
  js: "js",
  jsx: "js",
  mjs: "js",
  cjs: "js",
  vue: "js",
  py: "python",
  java: "java",
  kt: "java",
  kts: "java",
  cs: "java", // brace languages: java separators work well
  go: "go",
  rb: "ruby",
  php: "php",
  rs: "rust",
  scala: "scala",
  swift: "swift",
  c: "cpp",
  h: "cpp",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cxx: "cpp",
  sol: "sol",
  proto: "proto",
  html: "html",
  htm: "html",
  sql: undefined,
  sh: undefined,
  bash: undefined,
  ps1: undefined,
  psm1: undefined,
  yaml: undefined,
  yml: undefined,
  json: undefined,
  toml: undefined,
  xml: undefined,
  tf: undefined,
  bicep: undefined,
  gradle: undefined,
  ini: undefined,
  cfg: undefined,
  css: undefined,
  scss: undefined,
  graphql: undefined,
  gql: undefined,
  dockerfile: undefined,
};

const DOC_TYPES: Record<string, Omit<FileTypeInfo, "ext">> = {
  md: { parser: "text", kind: "markdown", language: "markdown" },
  mdx: { parser: "text", kind: "markdown", language: "markdown" },
  rst: { parser: "text", kind: "markdown", language: "rst" },
  txt: { parser: "text", kind: "text" },
  pdf: { parser: "pdf", kind: "text" },
  docx: { parser: "docx", kind: "text" },
  xlsx: { parser: "xlsx", kind: "table" },
  csv: { parser: "csv", kind: "table" },
  tsv: { parser: "csv", kind: "table" },
};

const SPECIAL_NAMES: Record<string, FileTypeInfo> = {
  dockerfile: { ext: "dockerfile", parser: "text", kind: "code" },
  makefile: { ext: "makefile", parser: "text", kind: "code" },
  jenkinsfile: { ext: "jenkinsfile", parser: "text", kind: "code" },
};

export function detectFileType(filePath: string): FileTypeInfo | null {
  const base = path.posix.basename(filePath).toLowerCase();
  if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (!ext) return null;
  const doc = DOC_TYPES[ext];
  if (doc) return { ext, ...doc };
  if (ext in CODE_LANG)
    return { ext, parser: "text", kind: "code", language: CODE_LANG[ext] };
  return null;
}

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "bin",
  "obj",
  "vendor",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "coverage",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  ".idea",
  ".gradle",
  ".terraform",
  ".cache",
  ".pytest_cache",
  ".mypy_cache",
]);

const IGNORED_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "poetry.lock",
  "cargo.lock",
  "gemfile.lock",
  "go.sum",
  ".ds_store",
  "thumbs.db",
]);

const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|pfx|p12|crt|cer|jks|keystore|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.?npmrc$/i,
  /^\.?pypirc$/i,
  /^\.?netrc$/i,
  /^credentials(\.json)?$/i,
  /secrets?\.(json|ya?ml|toml)$/i,
];

const MINIFIED = /\.(min\.(js|css)|map)$/i;

export function shouldIgnorePath(relPath: string): {
  ignore: boolean;
  reason?: string;
} {
  const parts = relPath.split("/");
  for (const dir of parts.slice(0, -1)) {
    if (IGNORED_DIRS.has(dir.toLowerCase()))
      return { ignore: true, reason: "ignored directory" };
  }
  const base = parts[parts.length - 1]!.toLowerCase();
  if (IGNORED_FILES.has(base))
    return { ignore: true, reason: "lock/system file" };
  if (
    base !== ".env.example" &&
    SECRET_FILE_PATTERNS.some((re) => re.test(base))
  ) {
    return { ignore: true, reason: "possible secrets file" };
  }
  if (MINIFIED.test(base))
    return { ignore: true, reason: "minified/generated" };
  return { ignore: false };
}
