import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { CliArgs } from "../types";
import { isRateLimitError } from "../global-queue";

const PROVIDER_FILE = fileURLToPath(import.meta.url);
const SCRIPTS_DIR = path.resolve(path.dirname(PROVIDER_FILE), "..");
const BUNDLED_WRAPPER = path.join(SCRIPTS_DIR, "agy-imagegen", "main.ts");

type WrapperOkResult = {
  status: "ok";
  path: string;
  bytes: number;
  elapsed_seconds: number;
  conversation_id: string | null;
  attempts: number;
  cached: boolean;
};

type WrapperErrorResult = {
  status: "error";
  path: string;
  bytes: number;
  error: string;
  error_kind: string;
};

type WrapperResult = WrapperOkResult | WrapperErrorResult;

export function getDefaultModel(): string {
  return "gemini-3.7-flash-medium";
}

export function getDefaultOutputExtension(): string {
  return ".jpg";
}

export function validateArgs(_model: string, args: CliArgs): void {
  if (args.n > 1) {
    throw new Error(
      "agy-cli provider supports only n=1 (agy generate_image returns a single image per call).",
    );
  }
  if (args.imageApiDialect && args.imageApiDialect !== "openai-native") {
    throw new Error(
      `Invalid imageApiDialect for agy-cli: ${args.imageApiDialect}. agy-cli does not use OpenAI Images API dialects.`,
    );
  }
  if (args.referenceImages.length > 3) {
    throw new Error(
      `agy-cli provider supports at most 3 reference images (agy generate_image's ImagePaths limit), got ${args.referenceImages.length}.`,
    );
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveWrapperPath(): Promise<string> {
  const override = process.env.BAOYU_AGY_IMAGEGEN_BIN;
  if (override) {
    if (!(await exists(override))) {
      throw new Error(
        `Invalid BAOYU_AGY_IMAGEGEN_BIN: ${override} does not exist.`,
      );
    }
    return override;
  }
  if (await exists(BUNDLED_WRAPPER)) return BUNDLED_WRAPPER;
  throw new Error(
    `agy-cli wrapper not found at ${BUNDLED_WRAPPER}. ` +
      `Reinstall baoyu-image-gen, or set BAOYU_AGY_IMAGEGEN_BIN to an agy-imagegen main.ts (or .sh) path.`,
  );
}

type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number;
};

async function spawnWrapper(wrapperPath: string, cliArgs: string[]): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const isTs = wrapperPath.endsWith(".ts");
    const command = isTs ? "bun" : wrapperPath;
    const args = isTs ? [wrapperPath, ...cliArgs] : cliArgs;
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

// The wrapper already retries `agent_refused` internally (BAOYU_AGY_IMAGEGEN_RETRIES),
// so most wrapper errors reaching here are genuinely exhausted — prefixing
// with "Invalid " is deliberate, it makes main.ts's isRetryableGenerationError
// treat them as non-retryable (a second full agy cold-start would just add
// latency for the same outcome). The one exception is a rate limit
// (agy's `error` field carrying an upstream 429/RESOURCE_EXHAUSTED/rate-limit
// body): that's a *different* quota pool than baoyu-image-gen's own, so it's
// worth letting the outer retry/429-cooldown machinery in main.ts and
// global-queue.ts have a go rather than failing the whole task outright.
export function buildWrapperError(parsed: WrapperErrorResult): Error {
  const detail = `${parsed.error_kind}): ${parsed.error}`;
  // `quota_exhausted` is the wrapper's explicit "agy's upstream image quota
  // is spent" signal (recovered from the run transcript); `agent_refused` +
  // rate-limit text is the older, less precise path to the same conclusion.
  // Both are agy's own Antigravity quota pool — a different pool from any
  // Vertex/OpenAI quota baoyu-image-gen manages — so let the outer
  // retry/429-cooldown machinery have a go instead of failing outright.
  if (
    parsed.error_kind === "quota_exhausted" ||
    (parsed.error_kind === "agent_refused" && isRateLimitError(parsed.error))
  ) {
    return new Error(`agy-cli rate limited (${detail}`);
  }
  return new Error(`Invalid agy-cli result (${detail}`);
}

function parseWrapperJson(stdout: string): WrapperResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Invalid agy-cli response: empty stdout from wrapper.");
  }
  const lastLine = trimmed.split(/\r?\n/).pop() ?? trimmed;
  try {
    return JSON.parse(lastLine) as WrapperResult;
  } catch (parseErr) {
    throw new Error(
      `Invalid agy-cli response: could not parse JSON from wrapper stdout (${(parseErr as Error).message}).`,
    );
  }
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

// Unlike parsePositiveInt, 0 is a meaningful value here (disable retries —
// one attempt only), so it must not collapse to "unset".
function parseNonNegativeInt(value: string | undefined): number | null {
  if (value == null || value === "") return null;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function getEnvOverride(name: string): string | null {
  const value = process.env[name];
  return value && value.length > 0 ? value : null;
}

export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const wrapperPath = await resolveWrapperPath();

  const sessionDir = path.join(tmpdir(), "baoyu-image-gen-agy-cli");
  await mkdir(sessionDir, { recursive: true });
  const token = randomBytes(8).toString("hex");
  const tmpOutput = path.join(sessionDir, `out-${token}.jpg`);
  const tmpPrompt = path.join(sessionDir, `prompt-${token}.md`);
  await writeFile(tmpPrompt, prompt, "utf8");

  const aspect = args.aspectRatio ?? "1:1";
  const cliArgs: string[] = [
    "--image",
    tmpOutput,
    "--prompt-file",
    tmpPrompt,
    "--aspect",
    aspect,
    "--model",
    model,
  ];

  for (const ref of args.referenceImages) {
    cliArgs.push("--ref", path.resolve(ref));
  }

  const cacheDir = getEnvOverride("BAOYU_AGY_IMAGEGEN_CACHE_DIR");
  if (cacheDir) cliArgs.push("--cache-dir", cacheDir);

  const timeoutMs = parsePositiveInt(process.env.BAOYU_AGY_IMAGEGEN_TIMEOUT_MS);
  if (timeoutMs) cliArgs.push("--timeout", String(timeoutMs));

  const retries = parseNonNegativeInt(process.env.BAOYU_AGY_IMAGEGEN_RETRIES);
  if (retries !== null) cliArgs.push("--retries", String(retries));

  const logFile = getEnvOverride("BAOYU_AGY_IMAGEGEN_LOG_FILE");
  if (logFile) cliArgs.push("--log-file", logFile);

  try {
    const spawnResult = await spawnWrapper(wrapperPath, cliArgs);
    const parsed = parseWrapperJson(spawnResult.stdout);

    if (parsed.status === "error") {
      throw buildWrapperError(parsed);
    }

    if (spawnResult.code !== 0) {
      throw new Error(
        `Invalid agy-cli result: wrapper exited with code ${spawnResult.code} despite reporting status=ok.`,
      );
    }

    const bytes = await readFile(parsed.path ?? tmpOutput);
    return new Uint8Array(bytes);
  } finally {
    await Promise.allSettled([
      rm(tmpOutput, { force: true }),
      rm(tmpPrompt, { force: true }),
    ]);
  }
}
