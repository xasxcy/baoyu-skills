#!/usr/bin/env bun
import { readFile, mkdir, mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { GenError, type CliOptions, type GenerateResult, type AgyRunResult } from "./types.ts";
import { runAgyExec, buildStatusErrorMessage } from "./spawn.ts";
import { verifyGeneration, verifySourceImage, copyOutputAtomic } from "./validator.ts";
import { cacheKey, lookupCache, storeCache } from "./cache.ts";
import { JsonLogger } from "./logger.ts";

const HELP = `agy-imagegen — generate images via Antigravity CLI's (agy) built-in generate_image tool

Usage:
  agy-imagegen --image <output.jpg> [--prompt <text> | --prompt-file <path>] [options]

Required:
  --image <path>          Output image path (JPEG bytes; keep a .jpg/.jpeg extension)
  --prompt <text>         Prompt text (or use --prompt-file)
  --prompt-file <path>    Read prompt from file

Options:
  --aspect <ratio>        Aspect ratio: 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, 16:9. Default: 1:1
  --model <name>          agy --model to run under. Default: gemini-3.7-flash-medium
  --ref <file>            Reference image (repeatable, max 3)
  --timeout <ms>          agy timeout in ms. Default: 300000
  --retries <n>           Retry attempts on retryable errors. Default: 2
  --retry-delay <ms>      Base retry delay (exponential). Default: 1500
  --cache-dir <path>      Enable idempotency cache. Disabled by default.
  --log-file <path>       Append JSONL log
  -v, --verbose           Verbose stderr logging
  -h, --help              Show this help

Stdout: single JSON line on success or failure.
`;

const ASPECT_RATIOS = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"]);
// agy is spawned array-form (no shell involved), so this isn't a shell-
// injection guard. Ref paths are interpolated into buildInstruction's
// refBlock wrapped in double quotes; these are the characters that could
// break out of that quoting or forge extra instruction lines.
const UNSAFE_PATH_CHARS = /[;|&`$<>\n\r()'"]/;

function assertSafePath(label: string, value: string): void {
  if (UNSAFE_PATH_CHARS.test(value)) {
    throw new GenError(
      "invalid_args",
      `${label} contains characters that would break out of the quoted reference-path list in the agy instruction: ${value}`,
      false,
    );
  }
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    prompt: "",
    promptFile: null,
    outputPath: "",
    aspect: "1:1",
    refImages: [],
    model: "gemini-3.7-flash-medium",
    timeoutMs: 300_000,
    retries: 2,
    retryDelayMs: 1500,
    cacheDir: null,
    logFile: null,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--prompt": opts.prompt = next(); break;
      case "--prompt-file": opts.promptFile = next(); break;
      case "--image": opts.outputPath = next(); break;
      case "--aspect": opts.aspect = next(); break;
      case "--model": opts.model = next(); break;
      case "--ref": opts.refImages.push(next()); break;
      case "--timeout": opts.timeoutMs = Number(next()); break;
      case "--retries": opts.retries = Number(next()); break;
      case "--retry-delay": opts.retryDelayMs = Number(next()); break;
      case "--cache-dir": opts.cacheDir = next(); break;
      case "--log-file": opts.logFile = next(); break;
      case "-v":
      case "--verbose": opts.verbose = true; break;
      case "-h":
      case "--help": process.stdout.write(HELP); process.exit(0);
      default: throw new GenError("invalid_args", `Unknown argument: ${a}`, false);
    }
  }
  if (!opts.outputPath) throw new GenError("invalid_args", "--image is required", false);
  if (opts.prompt && opts.promptFile) {
    throw new GenError("invalid_args", "--prompt and --prompt-file are mutually exclusive", false);
  }
  if (!opts.prompt && !opts.promptFile) {
    throw new GenError("invalid_args", "--prompt or --prompt-file required", false);
  }
  if (!ASPECT_RATIOS.has(opts.aspect)) {
    throw new GenError(
      "invalid_args",
      `--aspect must be one of ${[...ASPECT_RATIOS].join(", ")}, got: ${opts.aspect}`,
      false,
    );
  }
  if (opts.refImages.length > 3) {
    throw new GenError("invalid_args", "--ref accepts at most 3 reference images", false);
  }
  for (const [flag, value] of [
    ["--timeout", opts.timeoutMs],
    ["--retries", opts.retries],
    ["--retry-delay", opts.retryDelayMs],
  ] as const) {
    if (!Number.isFinite(value) || value < 0) {
      throw new GenError("invalid_args", `${flag} must be a non-negative number, got: ${value}`, false);
    }
  }

  // Resolve every filesystem path to absolute up front, so behavior is
  // independent of the caller's cwd.
  const cwd = process.cwd();
  const toAbs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(cwd, p));

  opts.outputPath = toAbs(opts.outputPath);
  if (opts.promptFile) opts.promptFile = toAbs(opts.promptFile);
  opts.refImages = opts.refImages.map(toAbs);
  if (opts.cacheDir) opts.cacheDir = toAbs(opts.cacheDir);
  if (opts.logFile) opts.logFile = toAbs(opts.logFile);

  // Ref image paths are interpolated raw into the agy instruction text (agy
  // has no --image/--attach flag; the model receives absolute paths and
  // passes them straight into generate_image's ImagePaths argument).
  for (const ref of opts.refImages) assertSafePath("--ref path", ref);

  return opts;
}

async function loadPrompt(opts: CliOptions): Promise<string> {
  if (opts.prompt) return opts.prompt;
  const file = opts.promptFile!;
  try {
    return await readFile(file, "utf-8");
  } catch {
    throw new GenError("prompt_file_missing", `Prompt file not found: ${file}`, false);
  }
}

function buildInstruction(prompt: string, opts: CliOptions): string {
  const refBlock = opts.refImages.length > 0
    ? `\nREFERENCE IMAGES: pass these absolute paths as the ImagePaths argument (in this order): ${opts.refImages.map((p) => `"${p}"`).join(", ")}\n`
    : "";
  return `You have an internal tool called generate_image. Call it EXACTLY ONCE, before doing anything else, with:
- Prompt: the PROMPT below
- AspectRatio: "${opts.aspect}"
- ImageName: "agy_imagegen_output"
${refBlock}
PROMPT:
${prompt}

After the tool call completes, reply with only the word: OK

HARD CONSTRAINTS:
- Call generate_image exactly once. Do not call it again even if the result looks imperfect.
- Do NOT use run_command, shell, or any file operation to copy, move, or inspect files.
- Do NOT search the filesystem for pre-existing images.
- Only generate_image produces the image; do not fabricate or describe a result without calling it.`;
}

// Only used when --cache-dir is set. Copies each ref to a private path we
// control before hashing/using it, so the bytes agy actually reads can't
// diverge from the bytes the cache key was computed from — closing the
// window between "we hash it" and "agy reads it ~15-30s later" that a plain
// re-read-before-use check wouldn't close (the file could still change in
// the gap between that recheck and agy's own read).
export async function snapshotRefs(refImages: string[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  if (refImages.length === 0) {
    return { paths: [], cleanup: async () => {} };
  }
  const dir = await mkdtemp(path.join(tmpdir(), "agy-imggen-refs-"));
  try {
    const paths: string[] = [];
    for (let i = 0; i < refImages.length; i++) {
      const dest = path.join(dir, `ref-${i}${path.extname(refImages[i])}`);
      await copyFile(refImages[i], dest);
      paths.push(dest);
    }
    return { paths, cleanup: () => rm(dir, { recursive: true, force: true }) };
  } catch (e) {
    // A failure partway through the copy loop must not leave the
    // already-copied refs (and the tmp dir itself) behind — there is no
    // caller to hand a cleanup callback to since this function never
    // returns one on this path.
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

// agy's top-level status is not trusted on its own in either direction — it
// can report ERROR (e.g. an internal 429 while calling its upstream image
// backend) even after generate_image already ran and saved a file. So a
// non-SUCCESS status doesn't short-circuit: this always runs the same
// transcript+file verification a SUCCESS status would go through, and only
// treats the run as a real failure if that verification itself fails.
// Exported (and taking `run` rather than calling runAgyExec itself) so this
// decision logic is unit-testable without spawning the real `agy` binary.
export async function resolveGenerationFromRun(
  run: AgyRunResult,
  outputPath: string,
  log: JsonLogger,
): Promise<{ bytes: number; conversationId: string | null; usage: AgyRunResult["usage"] }> {
  let sourcePath: string;
  try {
    ({ sourcePath } = await verifyGeneration(run.conversationId));
    await verifySourceImage(sourcePath);
  } catch (verifyErr) {
    if (run.status !== "SUCCESS") {
      // Verification couldn't recover an actual saved image, and agy itself
      // reported non-SUCCESS — this is a real failure. Surface agy's own
      // diagnostic text (rawError), not the generic verification error.
      throw new GenError(
        "agent_refused",
        buildStatusErrorMessage({ status: run.status, response: run.responseText ?? undefined, error: run.rawError ?? undefined }),
      );
    }
    throw verifyErr;
  }
  const bytes = await copyOutputAtomic(sourcePath, outputPath);

  if (run.status !== "SUCCESS") {
    // agy reported a failure (status/rawError below) but verification just
    // proved generate_image really ran and really saved a valid image — a
    // false negative from agy's own status field. Logged distinctly so we
    // can measure how often this happens and whether it's worth reporting
    // upstream to Antigravity.
    await log.info("status_error_but_recovered", {
      status: run.status,
      rawError: run.rawError,
      conversation_id: run.conversationId,
    });
  }

  return { bytes, conversationId: run.conversationId, usage: run.usage };
}

async function attemptGenerate(
  opts: CliOptions,
  instruction: string,
  attempt: number,
  log: JsonLogger,
): Promise<{ bytes: number; conversationId: string | null; usage: any }> {
  await log.info("attempt.start", { attempt, output: opts.outputPath, aspect: opts.aspect, model: opts.model });

  const run = await runAgyExec({
    instruction,
    model: opts.model,
    timeoutMs: opts.timeoutMs,
  });

  await log.info("agy.completed", {
    duration_ms: run.durationMs,
    conversation_id: run.conversationId,
    status: run.status,
    usage: run.usage,
    raw_log: run.rawLogPath,
  });

  return resolveGenerationFromRun(run, opts.outputPath, log);
}

async function generate(opts: CliOptions, log: JsonLogger): Promise<GenerateResult> {
  const startEpoch = Date.now();
  const prompt = await loadPrompt(opts);

  // Snapshotting is only needed for cache correctness: with no cache, a ref
  // is read exactly once by agy, whatever version it is, and nothing gets
  // reused later. With a cache, the snapshot is what makes "the bytes we
  // hashed" and "the bytes agy reads" the same bytes, closing the race a
  // plain hash-once-and-reuse fix does not (see snapshotRefs above).
  const snapshot = opts.cacheDir ? await snapshotRefs(opts.refImages) : null;
  const refImagesForRun = snapshot ? snapshot.paths : opts.refImages;

  try {
    const key = opts.cacheDir ? await cacheKey(prompt, opts.aspect, opts.model, refImagesForRun) : null;

    if (opts.cacheDir && key) {
      const cached = await lookupCache(opts.cacheDir, key);
      if (cached) {
        const bytes = await copyOutputAtomic(cached, opts.outputPath);
        await log.info("cache.hit", { key, source: cached });
        return {
          status: "ok",
          path: opts.outputPath,
          bytes,
          elapsed_seconds: 0,
          conversation_id: null,
          attempts: 0,
          cached: true,
          usage: null,
        };
      }
      await log.info("cache.miss", { key });
    }

    await mkdir(path.dirname(opts.outputPath), { recursive: true });
    const instruction = buildInstruction(prompt, { ...opts, refImages: refImagesForRun });

    let lastErr: GenError | null = null;
    let lastAttempt = 0;
    for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
      lastAttempt = attempt;
      try {
        const result = await attemptGenerate(opts, instruction, attempt, log);

        // The image is already validated and copied to opts.outputPath at
        // this point — a cache-store failure (full disk, unwritable dir,
        // failed rename) must not be treated as a failed generation. Caught
        // separately so it can't fall into the retry/error path below and
        // trigger a second paid agy call, or overwrite the already-good
        // output, for what is purely a best-effort side effect.
        if (opts.cacheDir && key) {
          try {
            await storeCache(opts.cacheDir, key, opts.outputPath);
            await log.info("cache.stored", { key });
          } catch (cacheErr) {
            await log.warn("cache.store_failed", { key, error: String(cacheErr) });
          }
        }

        return {
          status: "ok",
          path: opts.outputPath,
          bytes: result.bytes,
          elapsed_seconds: Math.round((Date.now() - startEpoch) / 1000),
          conversation_id: result.conversationId,
          attempts: attempt,
          cached: false,
          usage: result.usage,
        };
      } catch (e) {
        lastErr = e instanceof GenError ? e : new GenError("spawn_failed", String(e));
        await log.warn("attempt.failed", {
          attempt,
          kind: lastErr.kind,
          retryable: lastErr.retryable,
          error: lastErr.message,
        });
        if (!lastErr.retryable || attempt > opts.retries) break;
        const wait = opts.retryDelayMs * Math.pow(2, attempt - 1);
        await log.info("retry.wait", { wait_ms: wait, next_attempt: attempt + 1 });
        await delay(wait);
      }
    }

    const err = lastErr ?? new GenError("spawn_failed", "Unknown failure");
    err.attempts = lastAttempt;
    throw err;
  } finally {
    // A throw here would replace whatever the try block just returned or
    // threw (standard finally semantics) — turning an already-copied,
    // already-paid-for successful generation into a reported failure purely
    // because deleting a scratch tmp dir didn't work. Best-effort only.
    if (snapshot) {
      await snapshot.cleanup().catch((e) => log.warn("snapshot.cleanup_failed", { error: String(e) }));
    }
  }
}

async function main() {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    const err = e instanceof GenError ? e : new GenError("invalid_args", String(e), false);
    process.stderr.write(`Error: ${err.message}\n`);
    // The documented contract ("stdout: single JSON line on success or
    // failure") holds for argument errors too — callers like agy-cli.ts
    // parse stdout as JSON regardless of which stage failed, so a
    // stderr-only exit here would look like an empty/broken wrapper
    // response rather than a diagnosable invalid_args error.
    const out: GenerateResult = {
      status: "error",
      path: "",
      bytes: 0,
      elapsed_seconds: 0,
      conversation_id: null,
      attempts: 0,
      cached: false,
      usage: null,
      error: err.message,
      error_kind: err.kind,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(2);
  }

  const log = new JsonLogger(opts.logFile, opts.verbose);
  await log.info("start", { output: opts.outputPath, aspect: opts.aspect, model: opts.model, refs: opts.refImages.length });

  try {
    const result = await generate(opts, log);
    await log.info("done", { bytes: result.bytes, attempts: result.attempts, cached: result.cached });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(0);
  } catch (e) {
    const err = e instanceof GenError ? e : new GenError("spawn_failed", String(e));
    await log.error("failed", { kind: err.kind, error: err.message, attempts: err.attempts ?? 0 });
    const out: GenerateResult = {
      status: "error",
      path: opts.outputPath,
      bytes: 0,
      elapsed_seconds: 0,
      conversation_id: null,
      attempts: err.attempts ?? 0,
      cached: false,
      usage: null,
      error: err.message,
      error_kind: err.kind,
    };
    process.stdout.write(JSON.stringify(out) + "\n");
    process.exit(1);
  }
}

// Guarded so importing main.ts (e.g. from main.test.ts, to unit-test
// snapshotRefs) doesn't also run the CLI against the test runner's argv.
if (import.meta.main) {
  main();
}
