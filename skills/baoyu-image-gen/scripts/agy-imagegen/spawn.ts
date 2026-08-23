import { spawn } from "node:child_process";
import { writeFile, mkdtemp, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { GenError, type AgyRunResult } from "./types.ts";
import { parseAgyStdout, parseTranscript, toTokenUsage, type AgyStdoutJson } from "./parser.ts";

export interface SpawnInput {
  instruction: string;
  model: string;
  timeoutMs: number;
}

// Fixed per observed install layout; agy itself exposes no env var to
// override it. _AGY_IMAGEGEN_TEST_HOME is this wrapper's own internal test
// seam (not an agy feature) — Bun's os.homedir() ignores a runtime
// process.env.HOME mutation, so tests need another way to point this at a
// fixture directory.
export function antigravityHome(): string {
  const testHome = process.env._AGY_IMAGEGEN_TEST_HOME;
  if (testHome) return testHome;
  return path.join(homedir(), ".gemini", "antigravity-cli");
}

export function brainDir(conversationId: string): string {
  return path.join(antigravityHome(), "brain", conversationId);
}

// `response` is often empty or a meaningless placeholder ("OK") on a
// non-SUCCESS status — `error` is where agy actually puts the diagnostic
// text (e.g. the raw upstream 429 RESOURCE_EXHAUSTED body). Exported so
// callers get a real diagnosis without re-running agy by hand, and so this
// formatting is unit-testable without spawning a process.
export function buildStatusErrorMessage(parsed: Pick<AgyStdoutJson, "status" | "response" | "error">): string {
  const detail = parsed.error ? ` | error: ${parsed.error}` : "";
  return `agy reported status=${parsed.status}: ${parsed.response ?? ""}${detail}`;
}

export async function runAgyExec(input: SpawnInput): Promise<AgyRunResult> {
  const start = Date.now();
  const logDir = await mkdtemp(path.join(tmpdir(), "agy-imggen-"));
  const rawLogPath = path.join(logDir, "stdout.json");

  // Never pass --continue/-c/--conversation: each run must start a fresh
  // conversation so its brain/<conversation_id>/ dir contains only this
  // run's output, which is what makes the transcript-based verification and
  // the file lookup below trustworthy without cross-run ambiguity.
  const args = [
    "-p",
    input.instruction,
    "--model",
    input.model,
    "--dangerously-skip-permissions",
    "--sandbox",
    "--output-format",
    "json",
    "--print-timeout",
    `${Math.ceil(input.timeoutMs / 1000)}s`,
  ];

  let timedOut = false;
  let child;
  try {
    child = spawn("agy", args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new GenError("agy_not_installed", "agy CLI not installed", false);
    }
    throw new GenError("spawn_failed", `Failed to spawn agy: ${err.message}`);
  }

  let stdout = "";
  let stderr = "";
  let spawnError: NodeJS.ErrnoException | null = null;
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  // spawn() throws synchronously for some ENOENT cases but not others
  // (platform-dependent); this event covers the async case (e.g. EACCES,
  // or ENOENT under Node where it isn't thrown synchronously).
  child.on("error", (err) => {
    spawnError = err as NodeJS.ErrnoException;
  });

  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 2000);
  }, input.timeoutMs);

  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
  clearTimeout(timer);

  await writeFile(rawLogPath, stdout + (stderr ? `\n--- stderr ---\n${stderr}` : ""));

  if (spawnError) {
    if (spawnError.code === "ENOENT") {
      throw new GenError("agy_not_installed", "agy CLI not installed", false);
    }
    throw new GenError("spawn_failed", `Failed to spawn agy: ${spawnError.message} (log: ${rawLogPath})`);
  }
  if (timedOut) {
    throw new GenError("timeout", `agy exceeded ${input.timeoutMs}ms (log: ${rawLogPath})`);
  }
  if (exit.code !== 0) {
    if (stderr.includes("command not found") || stderr.includes("not found: agy")) {
      throw new GenError("agy_not_installed", "agy CLI not installed", false);
    }
    throw new GenError(
      "spawn_failed",
      `agy exited ${exit.code} signal=${exit.signal} (log: ${rawLogPath})`,
    );
  }

  let parsed;
  try {
    parsed = parseAgyStdout(stdout);
  } catch (e) {
    throw new GenError(
      "malformed_json",
      `Could not parse agy JSON output: ${(e as Error).message} (log: ${rawLogPath})`,
    );
  }

  if (parsed.status && parsed.status !== "SUCCESS") {
    throw new GenError("agent_refused", buildStatusErrorMessage(parsed));
  }

  return {
    conversationId: parsed.conversation_id ?? null,
    responseText: parsed.response ?? null,
    usage: toTokenUsage(parsed.usage),
    rawLogPath,
    durationMs: Date.now() - start,
  };
}

export async function readTranscript(conversationId: string) {
  const transcriptPath = path.join(
    brainDir(conversationId),
    ".system_generated",
    "logs",
    "transcript.jsonl",
  );
  const raw = await readFile(transcriptPath, "utf-8");
  return parseTranscript(raw);
}
