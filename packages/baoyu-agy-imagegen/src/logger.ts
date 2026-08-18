import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  [k: string]: unknown;
}

export class JsonLogger {
  constructor(private logFile: string | null, public verbose: boolean) {}

  async log(level: LogEntry["level"], event: string, extra: Record<string, unknown> = {}): Promise<void> {
    const entry: LogEntry = { ts: new Date().toISOString(), level, event, ...extra };
    const line = JSON.stringify(entry);
    if (this.verbose) process.stderr.write(`[${level}] ${event} ${jsonExtras(extra)}\n`);
    if (this.logFile) {
      // Best-effort: a diagnostic side-channel must never be able to crash
      // the primary operation. In particular, main.ts's error path awaits
      // log.error(...) before writing the fallback stdout JSON — if that
      // write threw, the wrapper would exit having emitted nothing on
      // stdout, breaking the "always one JSON line" contract callers rely
      // on to parse the actual failure.
      try {
        await mkdir(path.dirname(this.logFile), { recursive: true });
        await appendFile(this.logFile, line + "\n", "utf-8");
      } catch (e) {
        process.stderr.write(`[logger] failed to write --log-file ${this.logFile}: ${(e as Error).message}\n`);
      }
    }
  }

  info(event: string, extra?: Record<string, unknown>) {
    return this.log("info", event, extra);
  }
  warn(event: string, extra?: Record<string, unknown>) {
    return this.log("warn", event, extra);
  }
  error(event: string, extra?: Record<string, unknown>) {
    return this.log("error", event, extra);
  }
}

function jsonExtras(extra: Record<string, unknown>): string {
  const entries = Object.entries(extra);
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}
