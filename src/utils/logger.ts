type Level = "debug" | "info" | "warn" | "error";

const SECRET_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /(Authorization:\s*)(Basic|Bearer)\s+[A-Za-z0-9+/=._-]+/gi,
  /(\/\/)[^/@\s:]+:[^/@\s]+@/g,
  /(api[-_]?key["'=:\s]+)[A-Za-z0-9._-]{8,}/gi,
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (_m, p1?: string) =>
      typeof p1 === "string" && p1.length < 40
        ? `${p1}[REDACTED]`
        : "[REDACTED]",
    );
  }
  return out;
}

function write(level: Level, message: string, meta?: Record<string, unknown>) {
  const line = {
    time: new Date().toISOString(),
    level,
    message: redact(message),
    ...(meta ? JSON.parse(redact(JSON.stringify(meta))) : {}),
  };
  const out = JSON.stringify(line);
  if (level === "error" || level === "warn") console.error(out);
  else console.log(out);
}

export const logger = {
  debug: (m: string, meta?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug") write("debug", m, meta);
  },
  info: (m: string, meta?: Record<string, unknown>) => write("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => write("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => write("error", m, meta),
};
