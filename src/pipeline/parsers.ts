import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";
import Papa from "papaparse";
import { PDFParse } from "pdf-parse";
import type { ParsedSection } from "../types.js";
import type { FileTypeInfo } from "./fileTypes.js";

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    if ("richText" in value && Array.isArray(value.richText))
      return value.richText.map((r) => r.text).join("");
    if ("text" in value && typeof value.text === "string") return value.text; // hyperlink
    if ("result" in value)
      return cellToString(value.result as ExcelJS.CellValue); // formula
    if ("error" in value) return String(value.error);
    return "";
  }
  return String(value).replace(/\s+/g, " ").trim();
}

function rowsToSection(rows: string[][], label: string): ParsedSection | null {
  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return null;
  const [header, ...body] = nonEmpty;
  const headerLine = header!.join(" | ");
  return {
    kind: "table",
    label,
    text: [headerLine, ...body.map((r) => r.join(" | "))].join("\n"),
    tableHeader: headerLine,
    rows: body.map((r) => r.join(" | ")),
  };
}

async function parsePdf(buf: Buffer): Promise<ParsedSection[]> {
  const parser = new PDFParse({ data: buf });
  try {
    const result = await parser.getText();
    const sections = result.pages
      .map((p) => ({
        kind: "text" as const,
        label: `Page ${p.num}`,
        text: p.text,
      }))
      .filter((s) => s.text.trim().length > 0);
    if (sections.length === 0 && result.text.trim())
      return [{ kind: "text", text: result.text }];
    return sections;
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

async function parseXlsx(buf: Buffer): Promise<ParsedSection[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const sections: ParsedSection[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const values = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push(values.map((v) => cellToString(v as ExcelJS.CellValue)));
    });
    const s = rowsToSection(rows, `Sheet: ${sheet.name}`);
    if (s) sections.push(s);
  });
  return sections;
}

function parseCsv(text: string, ext: string): ParsedSection[] {
  const res = Papa.parse<string[]>(text, {
    delimiter: ext === "tsv" ? "\t" : "",
    skipEmptyLines: true,
  });
  const s = rowsToSection(
    res.data.map((r) => r.map((c) => String(c ?? "").trim())),
    "",
  );
  return s ? [{ ...s, label: undefined }] : [];
}

// ---------- PowerPoint (.pptx) ----------
// A .pptx is a zip of XML files. Text lives in <a:t> runs inside <a:p> paragraphs.

const XML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** Plain text of a slide/notes XML: one line per paragraph. */
function pptxXmlToText(xml: string, dropFields = false): string {
  const src = dropFields ? xml.replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "") : xml; // e.g. slide-number fields in notes
  const paragraphs = src.match(/<a:p\b[\s\S]*?<\/a:p>/g) ?? [];
  return paragraphs
    .map((p) =>
      [...p.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)]
        .map((m) => decodeXml(m[1]!))
        .join(""),
    )
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

/** Resolve a relationship target (e.g. "../notesSlides/notesSlide3.xml") relative to a part's folder. */
function resolvePart(baseDir: string, target: string): string {
  const parts = (target.startsWith("/") ? target.slice(1) : `${baseDir}/${target}`).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

function parseRels(xml: string | undefined): Map<string, { type: string; target: string }> {
  const rels = new Map<string, { type: string; target: string }>();
  for (const m of (xml ?? "").matchAll(/<Relationship\b[^>]*>/g)) {
    const tag = m[0];
    const id = /\bId="([^"]+)"/.exec(tag)?.[1];
    const type = /\bType="([^"]+)"/.exec(tag)?.[1] ?? "";
    const target = /\bTarget="([^"]+)"/.exec(tag)?.[1];
    if (id && target) rels.set(id, { type, target });
  }
  return rels;
}

async function parsePptx(buf: Buffer): Promise<ParsedSection[]> {
  const zip = await JSZip.loadAsync(buf);
  const read = (p: string) => zip.file(p)?.async("string");

  // Slides in presentation order (ppt/presentation.xml), falling back to file-name order.
  let slidePaths: string[] = [];
  const presXml = await read("ppt/presentation.xml");
  const presRels = parseRels(await read("ppt/_rels/presentation.xml.rels"));
  for (const m of (presXml ?? "").matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const rel = presRels.get(m[1]!);
    if (rel) slidePaths.push(resolvePart("ppt", rel.target));
  }
  if (slidePaths.length === 0) {
    slidePaths = Object.keys(zip.files)
      .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }

  const sections: ParsedSection[] = [];
  for (const [i, slidePath] of slidePaths.entries()) {
    const xml = await read(slidePath);
    if (!xml) continue;
    let text = pptxXmlToText(xml);

    // Speaker notes, linked from the slide's .rels file.
    const dir = slidePath.slice(0, slidePath.lastIndexOf("/"));
    const name = slidePath.slice(slidePath.lastIndexOf("/") + 1);
    const rels = parseRels(await read(`${dir}/_rels/${name}.rels`));
    for (const rel of rels.values()) {
      if (!rel.type.endsWith("/notesSlide")) continue;
      const notesXml = await read(resolvePart(dir, rel.target));
      const notes = notesXml ? pptxXmlToText(notesXml, true) : "";
      if (notes) text += `${text ? "\n\n" : ""}Speaker notes:\n${notes}`;
    }

    if (text.trim()) sections.push({ kind: "text", label: `Slide ${i + 1}`, text });
  }
  return sections;
}

export async function parseFile(
  absPath: string,
  type: FileTypeInfo,
): Promise<ParsedSection[]> {
  const buf = await fs.readFile(absPath);

  switch (type.parser) {
    case "text": {
      if (looksBinary(buf)) return [];
      const text = buf.toString("utf8");
      return text.trim()
        ? [{ kind: type.kind, language: type.language, text }]
        : [];
    }
    case "pdf":
      return parsePdf(buf);
    case "docx": {
      const { value } = await mammoth.extractRawText({ buffer: buf });
      return value.trim() ? [{ kind: "text", text: value }] : [];
    }
    case "pptx":
      return parsePptx(buf);
    case "xlsx":
      return parseXlsx(buf);
    case "csv":
      return parseCsv(buf.toString("utf8"), type.ext);
    default:
      return [];
  }
}
