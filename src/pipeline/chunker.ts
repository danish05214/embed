import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { config } from "../config.js";
import type { ChunkDraft, ContentKind, ParsedSection } from "../types.js";
import { normalizeText, sha256 } from "../utils/hash.js";
import { countTokens, truncateToTokens } from "../utils/tokens.js";

/** text-embedding-3 accepts 8,191 tokens; keep headroom for the context header. */
const MAX_EMBED_TOKENS = 8000;
const MIN_CHUNK_CHARS = 5;

function makeSplitter(kind: ContentKind, language?: string): RecursiveCharacterTextSplitter {
  const profile = config.chunking.profiles[kind === "table" ? "text" : kind];
  const params = {
    chunkSize: profile.chunkSize,
    chunkOverlap: profile.overlap,
    lengthFunction: countTokens, // sizes are in tokens, not characters
  };
  if (language) {
    return RecursiveCharacterTextSplitter.fromLanguage(
      language as Parameters<typeof RecursiveCharacterTextSplitter.fromLanguage>[0],
      params,
    );
  }
  return new RecursiveCharacterTextSplitter(params);
}

/** Group table rows into chunks under the token budget, repeating the header row in each. */
function chunkTable(section: ParsedSection): string[] {
  const budget = config.chunking.profiles.table.chunkSize;
  const header = section.tableHeader ?? "";
  const headerTokens = countTokens(header);
  const out: string[] = [];
  let current: string[] = [];
  let tokens = headerTokens;

  for (const row of section.rows ?? []) {
    const t = countTokens(row) + 1;
    if (current.length > 0 && tokens + t > budget) {
      out.push([header, ...current].join("\n"));
      current = [];
      tokens = headerTokens;
    }
    current.push(row);
    tokens += t;
  }
  if (current.length > 0) out.push([header, ...current].join("\n"));
  if (out.length === 0 && header) out.push(header);
  return out;
}

/** 1-based line number of a character offset. */
function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function contextHeader(filePath: string, section: ParsedSection): string {
  const parts = [`File: ${filePath}`];
  if (section.label) parts.push(section.label);
  if (section.language && section.kind === "code") parts.push(`Language: ${section.language}`);
  return parts.join(" | ");
}

/**
 * Split parsed sections into chunks with hashes and metadata.
 * - content    : the chunk text (stored, shown to the LLM, returned as citation snippet)
 * - embedText  : short context header + content (what gets embedded)
 * - chunkHash  : hash of normalised content -> detects which parts of a file changed
 * - embedHash  : hash of embedText -> embedding cache key (with model name)
 */
export async function chunkSections(filePath: string, sections: ParsedSection[]): Promise<ChunkDraft[]> {
  const drafts: ChunkDraft[] = [];

  for (const section of sections) {
    const pieces: { text: string; startLine?: number; endLine?: number }[] = [];

    if (section.kind === "table") {
      for (const t of chunkTable(section)) pieces.push({ text: t });
    } else {
      const source = section.text.replace(/\r\n?/g, "\n");
      const splitter = makeSplitter(section.kind, section.language);
      const texts = await splitter.splitText(source);
      let cursor = 0;
      for (const t of texts) {
        // Locate the chunk in the source to record line numbers (for citations / deep links).
        let pos = source.indexOf(t, cursor);
        if (pos < 0) pos = source.indexOf(t);
        if (pos >= 0) {
          pieces.push({ text: t, startLine: lineAt(source, pos), endLine: lineAt(source, pos + t.length) });
          cursor = pos + 1;
        } else {
          pieces.push({ text: t });
        }
      }
    }

    const header = contextHeader(filePath, section);
    for (const p of pieces) {
      const content = normalizeText(p.text);
      if (content.length < MIN_CHUNK_CHARS) continue;
      const embedText = truncateToTokens(`${header}\n\n${content}`, MAX_EMBED_TOKENS);
      drafts.push({
        content,
        embedText,
        chunkHash: sha256(content),
        embedHash: sha256(embedText),
        index: drafts.length,
        tokenCount: countTokens(embedText),
        metadata: {
          kind: section.kind,
          ...(section.language ? { language: section.language } : {}),
          ...(section.label ? { label: section.label } : {}),
          ...(p.startLine ? { startLine: p.startLine, endLine: p.endLine } : {}),
        },
      });
    }
  }
  return drafts;
}
