import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
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
// The DataTransfer upload path pushes each file through one browser command as
// base64; a 1.8 MB PNG failed ("sendCommand: max attempts exhausted") while a
// 292 KB JPEG succeeded. There is no measured threshold in between, so every
// reference is re-encoded unconditionally rather than guessing a cut-off.
// opencli's DataTransfer fallback used to send every file inside ONE browser command, so
// the limit was the TOTAL payload (4 refs: ~515 KB ok, ~765 KB failed). With the per-file
// upload patch (opencli branch feat/chatgpt-upload-one-file-at-a-time) each file is its own
// command and only the PER-FILE size matters: 190-350 KB files, 1.25 MB in total, uploaded
// fine, while 0.75-0.85 MB files still failed. Shrink each ref until it fits the per-file
// budget; set BAOYU_CHATGPT_WEB_REF_TOTAL_BYTES=500000 to also cap the total when running
// an unpatched opencli.
export const REF_PER_FILE_BUDGET_BYTES = 400_000;
export const REF_TIERS: ReadonlyArray<{ maxEdge: number; quality: number }> = [
  { maxEdge: 2000, quality: 90 },
  { maxEdge: 1536, quality: 85 },
  { maxEdge: 1280, quality: 80 },
  { maxEdge: 1024, quality: 78 },
  { maxEdge: 896, quality: 72 },
  { maxEdge: 768, quality: 68 },
];
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

async function assertJpegFile(file: string, converterName: string, input: string): Promise<void> {
  const fail = (why: string) =>
    new Error(`Invalid chatgpt-web reference image: ${converterName} produced no usable JPEG for ${input} (${why}).`);
  let handle;
  try {
    handle = await open(file, "r");
  } catch {
    throw fail("no output file");
  }
  try {
    // Structural sanity only (SOI at the start, EOI at the end): enough to catch
    // a converter that exited 0 without finishing the file, without pulling in a
    // decoder. Real sips/magick either complete or exit non-zero.
    const { size } = await handle.stat();
    const head = Buffer.alloc(3);
    const tail = Buffer.alloc(2);
    if (size < 8) throw fail("output is too small to be a JPEG");
    await handle.read(head, 0, 3, 0);
    await handle.read(tail, 0, 2, size - 2);
    if (head[0] !== 0xff || head[1] !== 0xd8) throw fail("output is not a JPEG");
    if (tail[0] !== 0xff || tail[1] !== 0xd9) throw fail("output looks truncated");
  } finally {
    await handle.close();
  }
}

export const fsHooks = { mkdtemp };

export type ConvertTier = { maxEdge: number; quality: number };
export type ImageConverter = { name: string; run: (input: string, output: string, tier: ConvertTier) => Promise<void> };

function execFileAsync(file: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve();
    });
  });
}

function execFileOutput(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? "") }));
      else resolve(String(stdout));
    });
  });
}

// `sips -Z` scales to fit the target, which would also enlarge small images
// (adding interpolation blur), so only pass it when the source is larger.
// sips prints the input path first and the metadata lines after it, so only
// anchored, indented lines count and the last one wins; a path that merely
// contains "pixelWidth: 999999" must not be able to forge the size.
export function parseSipsDimensions(info: string): { width: number; height: number } | null {
  const last = (key: string): number | null => {
    const found = [...info.matchAll(new RegExp(`^[ \\t]+${key}:[ \\t]*(\\d+)[ \\t]*$`, "gm"))];
    return found.length > 0 ? Number(found[found.length - 1]![1]) : null;
  };
  const width = last("pixelWidth");
  const height = last("pixelHeight");
  return width !== null && height !== null ? { width, height } : null;
}

async function sipsNeedsDownscale(input: string, maxEdge: number): Promise<boolean> {
  const info = await execFileOutput("sips", ["-g", "pixelWidth", "-g", "pixelHeight", input]);
  const dims = parseSipsDimensions(info);
  // Unreadable dimensions: never risk an enlargement; the conversion itself will
  // fail loudly if the file is not an image.
  return dims !== null && Math.max(dims.width, dims.height) > maxEdge;
}

export const DEFAULT_CONVERTERS: ImageConverter[] = [
  {
    name: "sips",
    run: async (input, output, tier) => {
      const args = ["-s", "format", "jpeg", "-s", "formatOptions", String(tier.quality)];
      if (await sipsNeedsDownscale(input, tier.maxEdge)) args.push("-Z", String(tier.maxEdge));
      await execFileAsync("sips", [...args, input, "--out", output]);
    },
  },
  {
    name: "magick",
    // The trailing ">" makes ImageMagick shrink only, never enlarge.
    run: (input, output, tier) =>
      execFileAsync("magick", [input, "-auto-orient", "-resize", `${tier.maxEdge}x${tier.maxEdge}>`, "-quality", String(tier.quality), output]),
  },
];

// Re-encodes every reference into `dir` (never touching the caller's files).
// A converter that is not installed (ENOENT) falls through to the next one; if
// none is installed the originals are passed through with a warning. A
// converter that runs but fails means the image itself is unusable.
export async function normalizeReferences(
  refs: string[],
  dir: string,
  converters: ImageConverter[] = DEFAULT_CONVERTERS,
  tiers: ReadonlyArray<ConvertTier> = REF_TIERS,
  perFileBudget: number = REF_PER_FILE_BUDGET_BYTES,
  totalBudget: number = Infinity,
): Promise<string[]> {
  if (refs.length === 0) return [];
  let out: string[] = [];
  for (const [tierIndex, tier] of tiers.entries()) {
    out = [];
    let total = 0;
    let largest = 0;
    let passthrough = false;
    for (const [index, ref] of refs.entries()) {
      const input = path.resolve(ref);
      const output = path.join(dir, `ref-${index + 1}.jpg`);
      let converted = false;
      for (const converter of converters) {
        try {
          await converter.run(input, output, tier);
          // sips exits 0 with only a warning when the input is missing or invalid,
          // so a clean exit proves nothing: the output itself must be a real JPEG.
          await assertJpegFile(output, converter.name, input);
          converted = true;
          break;
        } catch (err) {
          if ((err as Error).message?.startsWith("Invalid ")) throw err;
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          const detail = String((err as { stderr?: string }).stderr || (err as Error).message).trim().split(/\r?\n/)[0];
          throw new Error(`Invalid chatgpt-web reference image: ${converter.name} could not re-encode ${input} (${detail}).`);
        }
      }
      if (!converted) {
        process.stderr.write(
          `chatgpt-web: no image converter found (tried ${converters.map((c) => c.name).join(", ")}); uploading ${input} as-is, large files may fail to upload.\n`,
        );
        out.push(input);
        passthrough = true;
      } else {
        out.push(output);
        const size = (await stat(output)).size;
        total += size;
        largest = Math.max(largest, size);
      }
    }
    if (passthrough || (largest <= perFileBudget && total <= totalBudget)) return out;
    if (tierIndex === tiers.length - 1) {
      process.stderr.write(`chatgpt-web: references still exceed the upload budget at the smallest setting (largest ${largest} bytes, total ${total}); the upload may fail.\n`);
    }
  }
  return out;
}

function envTotalBudget(): number {
  const n = Number(process.env.BAOYU_CHATGPT_WEB_REF_TOTAL_BYTES);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

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
  const outDir = await fsHooks.mkdtemp(path.join(root, "out-"));
  let refDir: string | null = null;

  try {
    // Allocated inside the try so a failure here still cleans up outDir.
    refDir = await fsHooks.mkdtemp(path.join(root, "ref-"));
    const referenceImages = await normalizeReferences(args.referenceImages, refDir, DEFAULT_CONVERTERS, REF_TIERS, REF_PER_FILE_BUDGET_BYTES, envTotalBudget());
    const cliArgs = buildOpencliArgs(prompt, { ...args, referenceImages }, outDir, {
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
    for (const dir of [outDir, refDir]) {
      if (!dir) continue;
      await rm(dir, { recursive: true, force: true }).catch((err) => {
        process.stderr.write(`chatgpt-web: could not remove temp dir ${dir}: ${String(err)}\n`);
      });
    }
  }
}
