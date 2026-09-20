import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import type { CliArgs } from "../types";

// Drives the ChatGPT web UI through `opencli chatgpt image`. The image is
// generated against the logged-in ChatGPT account's web image allowance, not
// an API key. opencli is the wrapper, so there is no bundled scripts/ tree.
//
// Failure policy: every error carries an "Invalid " prefix so main.ts's
// isRetryableGenerationError never retries. A dropped browser connection may
// have already submitted the prompt, and a blind retry would burn a second
// image of the web quota for the same outcome.

const DEFAULT_BIN = "opencli";
const DEFAULT_TIMEOUT_MS = 240_000;
// Extra wall-clock beyond opencli's own --timeout before we terminate the process.
const KILL_GRACE_MS = 30_000;
// After SIGTERM, how long to wait before escalating to SIGKILL.
const SIGKILL_AFTER_MS = 5_000;
// Conservative cap; the ChatGPT web composer accepts more, but this matches
// the edit endpoint limit other CLI wrappers use and keeps identity refs few.
export const MAX_REFERENCE_IMAGES = 5;

type OpencliRow = {
  status?: string;
  file?: string;
  link?: string;
};

export function getDefaultModel(): string {
  // opencli cannot pick a model; the web UI chooses. This is only a label.
  return "chatgpt-web";
}

export function getDefaultOutputExtension(): string {
  return ".png";
}

export function validateArgs(model: string, args: CliArgs): void {
  if (model && model !== getDefaultModel()) {
    throw new Error(
      `Invalid model for chatgpt-web: ${model}. The ChatGPT web UI chooses the model; omit --model or use "${getDefaultModel()}".`,
    );
  }
  if (args.n !== 1) {
    throw new Error(`chatgpt-web provider supports only n=1 (one web generation per call), got ${args.n}.`);
  }
  if (args.size) {
    throw new Error("chatgpt-web provider does not support --size; the web UI picks the canvas. Use --ar for an aspect-ratio hint.");
  }
  if (args.imageApiDialect && args.imageApiDialect !== "openai-native") {
    throw new Error(
      `Invalid imageApiDialect for chatgpt-web: ${args.imageApiDialect}. chatgpt-web does not use OpenAI Images API dialects.`,
    );
  }
  if (args.referenceImages.length > MAX_REFERENCE_IMAGES) {
    throw new Error(
      `chatgpt-web provider supports at most ${MAX_REFERENCE_IMAGES} reference images, got ${args.referenceImages.length}.`,
    );
  }
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveTimeoutMs(): number {
  return parsePositiveInt(process.env.BAOYU_CHATGPT_WEB_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
}

export function buildPrompt(prompt: string, args: CliArgs): string {
  let text = prompt;
  // opencli has no aspect flag; a prompt hint is the only lever.
  if (args.aspectRatio) text += `\n\nAspect ratio: ${args.aspectRatio}.`;
  // opencli (commander) would read a leading "-" as an option flag.
  if (text.startsWith("-")) text = `\n${text}`;
  return text;
}

export function buildOpencliArgs(
  prompt: string,
  args: CliArgs,
  outDir: string,
  opts: { profile?: string | null; timeoutMs: number },
): string[] {
  const cli: string[] = [];
  // --profile is a global option and must precede the site subcommand.
  if (opts.profile) cli.push("--profile", opts.profile);
  cli.push("chatgpt", "image", buildPrompt(prompt, args));
  if (args.referenceImages.length > 0) {
    cli.push("--image", args.referenceImages.map((ref) => path.resolve(ref)).join(","));
  }
  cli.push("--op", outDir, "--timeout", String(Math.ceil(opts.timeoutMs / 1000)), "-f", "json");
  return cli;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    // opencli may print update notices around the JSON payload.
    const start = trimmed.search(/^[\[{]/m);
    if (start < 0) return null;
    try {
      return JSON.parse(trimmed.slice(start));
    } catch {
      return null;
    }
  }
}

function stripDecoration(value: string): string {
  // Rows look like "📁 /abs/path.png"; drop everything before the path root.
  const match = value.match(/(~?\/.*)$/);
  return match ? match[1]!.trim() : value.trim();
}

export function parseSavedFile(stdout: string): string {
  const parsed = extractJson(stdout);
  const rows: OpencliRow[] = Array.isArray(parsed) ? (parsed as OpencliRow[]) : [];
  const saved = rows.find((row) => typeof row.file === "string" && row.file.includes("/") && /saved/i.test(row.status ?? ""));
  if (!saved?.file) {
    throw new Error("Invalid chatgpt-web response: no saved image row in opencli output.");
  }
  const file = stripDecoration(saved.file);
  return file.startsWith("~/") ? path.join(os.homedir(), file.slice(2)) : file;
}

export function assertInsideDir(file: string, dir: string): string {
  const resolved = path.resolve(file);
  const rel = path.relative(path.resolve(dir), resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `Invalid chatgpt-web result: opencli reported a file outside this call's output dir (${resolved}); refusing to read it. The image may exist there.`,
    );
  }
  return resolved;
}

export function buildOpencliError(stdout: string, stderr: string, code: number): Error {
  const text = `${stdout}\n${stderr}`;
  const errCode = text.match(/^\s*code:\s*(\S+)/m)?.[1] ?? "unknown";
  const message = text.match(/^\s*message:\s*(.+)$/m)?.[1]?.trim() ?? text.trim().split(/\r?\n/).pop() ?? "";
  const hint =
    errCode === "SESSION_BUSY"
      ? " Another opencli ChatGPT command is driving the session; wait for it or stop it."
      : "";
  return new Error(`Invalid chatgpt-web result (exit ${code}, ${errCode}): ${message}.${hint}`);
}

type SpawnResult = { stdout: string; stderr: string; code: number };

export function runOpencli(
  bin: string,
  cliArgs: string[],
  timeoutMs: number,
  graceMs: number = KILL_GRACE_MS,
  sigkillAfterMs: number = SIGKILL_AFTER_MS,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, cliArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      // A process that ignores SIGTERM must not wedge the queue or leak the temp dir.
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
        settle(() =>
          reject(
            new Error(
              `Invalid chatgpt-web result: opencli ignored SIGTERM and was killed after ${Math.round((timeoutMs + graceMs) / 1000)}s; the prompt may already have been submitted.`,
            ),
          ),
        );
      }, sigkillAfterMs);
    }, timeoutMs + graceMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => settle(() => reject(err)));
    child.on("close", (code) => {
      settle(() => {
        if (killTimer !== null || code === null) {
          reject(
            new Error(
              `Invalid chatgpt-web result: opencli did not exit within ${Math.round((timeoutMs + graceMs) / 1000)}s and was terminated; the prompt may already have been submitted.`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code });
      });
    });
  });
}

export async function generateImage(
  prompt: string,
  _model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const bin = process.env.BAOYU_CHATGPT_WEB_BIN || DEFAULT_BIN;
  const timeoutMs = resolveTimeoutMs();

  const root = path.join(os.tmpdir(), "baoyu-image-gen-chatgpt-web");
  await mkdir(root, { recursive: true });
  const outDir = await mkdtemp(path.join(root, "out-"));

  try {
    const cliArgs = buildOpencliArgs(prompt, args, outDir, {
      profile: process.env.BAOYU_CHATGPT_WEB_PROFILE,
      timeoutMs,
    });
    let result: SpawnResult;
    try {
      result = await runOpencli(bin, cliArgs, timeoutMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `Invalid chatgpt-web setup: "${bin}" not found. Install opencli (npm i -g @jackwener/opencli) or set BAOYU_CHATGPT_WEB_BIN.`,
        );
      }
      throw err;
    }
    if (result.code !== 0) {
      throw buildOpencliError(result.stdout, result.stderr, result.code);
    }
    // Everything after dispatch must stay "Invalid "-prefixed: the prompt was
    // already accepted, so a raw ENOENT here must not trigger a second generation.
    try {
      const file = assertInsideDir(parseSavedFile(result.stdout), outDir);
      const bytes = await readFile(file);
      return new Uint8Array(bytes);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith("Invalid ")) throw err;
      throw new Error(`Invalid chatgpt-web result: could not read the generated image (${message}).`, { cause: err });
    }
  } finally {
    // Cleanup failures must never mask the result or turn into a retryable error.
    await rm(outDir, { recursive: true, force: true }).catch((err) => {
      process.stderr.write(`chatgpt-web: could not remove temp dir ${outDir}: ${String(err)}\n`);
    });
  }
}
