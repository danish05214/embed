import fs from "node:fs/promises";
import ExcelJS from "exceljs";
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
    case "xlsx":
      return parseXlsx(buf);
    case "csv":
      return parseCsv(buf.toString("utf8"), type.ext);
    default:
      return [];
  }
}
