import { spawn } from "node:child_process";
import { writeFile, mkdtemp, readFile, stat, open, opendir } from "node:fs/promises";
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

  // Whether a non-SUCCESS status is actually a failure is decided by the
  // caller, not here: agy can report ERROR (e.g. an internal 429 hit while
  // calling its upstream image backend) even after generate_image already
  // ran and saved a file. The caller (main.ts's attemptGenerate) verifies
  // via the transcript + saved file before deciding, so this always returns
  // a result rather than throwing on status alone.
  return {
    conversationId: parsed.conversation_id ?? null,
    responseText: parsed.response ?? null,
    usage: toTokenUsage(parsed.usage),
    rawLogPath,
    durationMs: Date.now() - start,
    startedAtMs: start,
    status: parsed.status ?? "SUCCESS",
    rawError: parsed.error ?? null,
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

// Read the whole file when it's this size or smaller — every real
// `agy -p` invocation log (a geo-gated run aborts in ~1 s) is far under
// this. Only a pathological log exceeds it, and then a bounded head+tail
// slice is read instead: the conversation-id header lands near the start
// and the geo-gate line near the end, so both regions are covered without
// loading an unbounded amount.
const SERVER_LOG_WHOLE_MAX_BYTES = 2_097_152; // 2 MiB
const SERVER_LOG_HEAD_BYTES = 131_072; // 128 KiB
const SERVER_LOG_TAIL_BYTES = 524_288; // 512 KiB
// Slack subtracted from `sinceMs`. Filesystem mtimes can be rounded down
// to 1–2 s granularity (FAT, some network filesystems), so a log created
// microseconds after the spawn instant can report an mtime just below it.
// Widening the lower bound backwards is safe: every run gets a fresh
// conversation id (runAgyExec never passes --continue), so a log from
// before this spawn cannot carry this id.
const SERVER_LOG_MTIME_GRACE_MS = 2_000;
// Runaway guard applied *after* content correlation — a single run writes
// a handful of logs, so this many id-matches means something is very
// wrong; stop there.
const SERVER_LOG_MAX_CORRELATED = 50;
// Ceilings that keep this error path bounded regardless of how full the
// shared `log/` dir is. `cli-<YYYYMMDD_HHMMSS>.log` names sort
// chronologically, so "newest by name" needs no stat. This run's own logs
// carry a name-timestamp ≈ its spawn instant, so they sit among the
// newest names unless thousands of `agy` processes started after it inside
// the (seconds-wide) verification window — not physically reachable.
//   NAME_CANDIDATES: how many newest-named cli-*.log we keep from the
//     streamed directory scan (bounds enumeration memory + the stat loop).
//   MAX_SCAN: how many of those, after the mtime-window filter, we open
//     and read (bounds I/O).
const SERVER_LOG_NAME_CANDIDATES = 2048;
const SERVER_LOG_MAX_SCAN = 512;

// Stream the log dir and return at most `keep` of the newest-named
// cli-*.log files (ascending). `opendir` iteration means a directory with
// millions of stale entries never materializes all at once; the periodic
// compaction keeps held names near `keep`.
async function newestLogNames(logDir: string, keep: number): Promise<string[]> {
  let dir;
  try {
    dir = await opendir(logDir);
  } catch {
    return [];
  }
  let names: string[] = [];
  try {
    for await (const ent of dir) {
      if (!ent.isFile()) continue;
      const n = ent.name;
      if (!n.startsWith("cli-") || !n.endsWith(".log")) continue;
      names.push(n);
      if (names.length >= keep * 4) {
        names.sort();
        names = names.slice(names.length - keep);
      }
    }
  } catch {
    // A mid-iteration error still leaves a usable partial list.
  }
  names.sort();
  return names.slice(Math.max(0, names.length - keep));
}

async function readLogForScan(file: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(file, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await fh.stat();
    if (size <= 0) return "";
    if (size <= SERVER_LOG_WHOLE_MAX_BYTES) {
      const buf = Buffer.alloc(size);
      await fh.read(buf, 0, size, 0);
      return buf.toString("utf-8");
    }
    const head = Buffer.alloc(SERVER_LOG_HEAD_BYTES);
    await fh.read(head, 0, SERVER_LOG_HEAD_BYTES, 0);
    const tail = Buffer.alloc(SERVER_LOG_TAIL_BYTES);
    await fh.read(tail, 0, SERVER_LOG_TAIL_BYTES, size - SERVER_LOG_TAIL_BYTES);
    return head.toString("utf-8") + "\n" + tail.toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

// Some failures (notably Google's geo/ASN gate on the model call) leave
// NOTHING in the run's brain-dir transcript or the stdout JSON — the only
// place the real diagnostic text appears is agy's per-invocation server
// log at `<antigravityHome>/log/cli-<timestamp>.log`. A single `agy -p` run
// writes MORE than one of these (a startup/auth log, then the streaming
// log) and only one carries the executor error, so this returns the
// contents of *every* matching cli-*.log, joined — picking just "the
// newest that matches the id" could hand back the companion log that has
// the id but not the error line.
//
// `sinceMs` (this run's spawn instant, from AgyRunResult.startedAtMs) is
// REQUIRED: it bounds the mtime window to this run's own lifetime, so the
// number of files that pass is inherently small and no unrelated log can
// crowd this run's out of view. A file is kept when mtime >= sinceMs -
// grace AND its (bounded) content mentions this `conversationId` — content
// correlation, with no newest-N cap ahead of it beyond the pathological-dir
// ceilings above. Every stage — directory enumeration, stat, read — is
// bounded.
//
// Best-effort: any fs problem returns null and the caller falls back to its
// normal classification. null when no matching log is found.
export async function readServerLogForConversation(
  conversationId: string,
  sinceMs: number,
): Promise<string | null> {
  const logDir = path.join(antigravityHome(), "log");
  const names = await newestLogNames(logDir, SERVER_LOG_NAME_CANDIDATES);
  if (names.length === 0) return null;

  const floor = sinceMs - SERVER_LOG_MTIME_GRACE_MS;
  const inWindow: { file: string; mtimeMs: number }[] = [];
  for (const name of names) {
    const file = path.join(logDir, name);
    try {
      const { mtimeMs } = await stat(file);
      if (mtimeMs >= floor) inWindow.push({ file, mtimeMs });
    } catch {
      continue;
    }
  }
  // Newest first so the read ceiling, if a pathological dir ever trips it,
  // keeps this run's own (in-window, hence newest) logs.
  inWindow.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matches: string[] = [];
  for (const { file } of inWindow.slice(0, SERVER_LOG_MAX_SCAN)) {
    const text = await readLogForScan(file);
    if (text === null || !text.includes(conversationId)) continue;
    matches.push(text);
    if (matches.length >= SERVER_LOG_MAX_CORRELATED) break;
  }
  return matches.length > 0 ? matches.join("\n") : null;
}
