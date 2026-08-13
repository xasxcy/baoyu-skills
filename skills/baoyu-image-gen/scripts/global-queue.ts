/**
 * Cross-process global image generation queue.
 *
 * Solves Hermes spawning multiple independent baoyu-image-gen processes that
 * each ignore in-process rate limits and stampede Vertex into 429s.
 *
 * Features:
 * - File-backed lock + shared state under ~/.baoyu-skills/image-gen-queue/
 * - Queue key: provider (+ for vertex: project|location|model)
 * - Shared cooldown after 429 (starts at 60s, expands on consecutive 429s)
 * - In-flight dedup by absolute output path and task hash
 * - Concurrency gate (default 1 for vertex)
 */

import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

export type QueueResourceKey = string;

export type InflightEntry = {
  pid: number;
  outputPath: string;
  taskHash: string;
  startedAt: number;
  ownerToken: string;
  /** Signature of a non-empty output that existed before this owner started. */
  priorOutput: OutputSignature | null;
};

type OutputSignature = {
  size: number;
  mtimeMs: number;
};

export type QueueState = {
  version: 1;
  active: number;
  lastStartedAt: number;
  cooldownUntil: number;
  consecutive429: number;
  inflight: Record<string, InflightEntry>; // key = outputPath or taskHash
};

export type QueueLimits = {
  concurrency: number;
  startIntervalMs: number;
};

export type AcquireOptions = {
  resourceKey: QueueResourceKey;
  outputPath: string;
  taskHash: string;
  limits: QueueLimits;
  /** Max ms to wait for slot / dedup peer (default 30 min) */
  maxWaitMs?: number;
  pollMs?: number;
  now?: () => number;
  queueRoot?: string;
};

export type AcquireResult =
  | {
      mode: "run";
      release: (outcome: ReleaseOutcome) => Promise<void>;
    }
  | {
      mode: "joined";
      /** Absolute path that the peer wrote (or should write) */
      outputPath: string;
    };

export type ReleaseOutcome =
  | { kind: "success" }
  | { kind: "error"; status?: number | null; message?: string; is429?: boolean }
  | { kind: "cancelled" };

const STATE_VERSION = 1 as const;
const DEFAULT_POLL_MS = 250;
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1000;
const STALE_INFLIGHT_MS = 20 * 60 * 1000;
const LOCK_STALE_MS = 30_000;
const BASE_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 15 * 60_000;

function defaultQueueRoot(): string {
  return (
    process.env.BAOYU_IMAGE_GEN_QUEUE_DIR ||
    path.join(homedir(), ".baoyu-skills", "image-gen-queue")
  );
}

export function sanitizeResourceKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180) || "default";
}

/** Vertex project + location + model (diagnosis §1). */
export function buildVertexResourceKey(opts: {
  projectId: string;
  location: string;
  model: string;
}): QueueResourceKey {
  return `vertex:${opts.projectId}|${opts.location}|${opts.model}`;
}

export function buildProviderResourceKey(provider: string, model: string): QueueResourceKey {
  if (provider === "vertex") {
    // Callers should prefer buildVertexResourceKey; this is a fallback.
    const project =
      process.env.VERTEX_PROJECT_ID ||
      process.env.GOOGLE_CLOUD_PROJECT ||
      "default-project";
    const location = process.env.VERTEX_LOCATION || "global";
    return buildVertexResourceKey({ projectId: project, location, model });
  }
  return `${provider}:${model}`;
}

export function computeTaskHash(parts: {
  provider: string;
  model: string;
  prompt: string;
  aspectRatio?: string | null;
  size?: string | null;
  imageSize?: string | null;
  quality?: string | null;
  imageApiDialect?: string | null;
  n?: number;
  responseFormat?: string | null;
  referenceImages?: string[];
}): string {
  const h = createHash("sha256");
  h.update(
    JSON.stringify({
      provider: parts.provider,
      model: parts.model,
      prompt: parts.prompt,
      aspectRatio: parts.aspectRatio ?? null,
      size: parts.size ?? null,
      imageSize: parts.imageSize ?? null,
      quality: parts.quality ?? null,
      imageApiDialect: parts.imageApiDialect ?? null,
      n: parts.n ?? 1,
      responseFormat: parts.responseFormat ?? null,
      // Reference order is meaningful for multi-image edit providers.
      refs: (parts.referenceImages ?? []).map((p) => path.resolve(p)),
    }),
  );
  return h.digest("hex").slice(0, 24);
}

export function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /\b429\b/.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg) ||
    /rate.?limit/i.test(msg) ||
    (/quota/i.test(msg) && /exceed/i.test(msg))
  );
}

export function extractHttpStatus(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const m =
    msg.match(/error\s*\((\d{3})\)/i) ||
    msg.match(/\bHTTP\s+(\d{3})\b/i) ||
    msg.match(/\bstatus(?:Code)?[:=]\s*(\d{3})\b/i);
  return m ? Number(m[1]) : null;
}

/** Truncated exponential backoff with jitter (diagnosis §2). */
export function computeRetryDelayMs(attempt: number, opts?: { random?: () => number }): number {
  const r = opts?.random ?? Math.random;
  // attempt is 1-based after a failure
  const ranges: Array<[number, number]> = [
    [2000, 4000],
    [8000, 12000],
    [30000, 45000],
    [60000, 90000],
  ];
  const idx = Math.min(Math.max(attempt, 1), ranges.length) - 1;
  const [lo, hi] = ranges[idx]!;
  return Math.floor(lo + r() * (hi - lo));
}

export function computeCooldownMs(consecutive429: number): number {
  // 60s, 120s, 240s... capped
  const exp = Math.max(0, consecutive429 - 1);
  return Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** exp);
}

function emptyState(): QueueState {
  return {
    version: STATE_VERSION,
    active: 0,
    lastStartedAt: 0,
    cooldownUntil: 0,
    consecutive429: 0,
    inflight: {},
  };
}

function pathsFor(resourceKey: QueueResourceKey, queueRoot?: string) {
  const root = queueRoot ?? defaultQueueRoot();
  const safe = sanitizeResourceKey(resourceKey);
  return {
    root,
    dir: path.join(root, safe),
    statePath: path.join(root, safe, "state.json"),
    lockPath: path.join(root, safe, "lock"),
  };
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function readState(statePath: string): Promise<QueueState> {
  try {
    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as QueueState;
    if (!parsed || parsed.version !== STATE_VERSION || typeof parsed.inflight !== "object") {
      return emptyState();
    }
    return {
      ...emptyState(),
      ...parsed,
      inflight: parsed.inflight ?? {},
    };
  } catch {
    return emptyState();
  }
}

async function writeStateAtomic(statePath: string, state: QueueState): Promise<void> {
  const tmp = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, statePath);
}

async function pidAlive(pid: number): Promise<boolean> {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function pruneStale(state: QueueState, now: number): Promise<QueueState> {
  const next = { ...state, inflight: { ...state.inflight } };
  let removed = 0;
  for (const [key, entry] of Object.entries(next.inflight)) {
    const alive = await pidAlive(entry.pid);
    const stale = now - entry.startedAt > STALE_INFLIGHT_MS;
    if (!alive || stale) {
      delete next.inflight[key];
      removed += 1;
    }
  }
  if (removed > 0) {
    next.active = Math.max(0, Object.keys(next.inflight).length);
  } else {
    // Keep active aligned with unique owner tokens
    const owners = new Set(Object.values(next.inflight).map((e) => e.ownerToken));
    next.active = owners.size;
  }
  return next;
}

/**
 * Best-effort exclusive lock via O_EXCL create.
 * If lock is stale (old mtime + no holder), break it.
 */
async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  opts?: { now?: () => number; pollMs?: number; maxWaitMs?: number },
): Promise<T> {
  const nowFn = opts?.now ?? Date.now;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const maxWaitMs = opts?.maxWaitMs ?? 15_000;
  const started = nowFn();
  let handle: FileHandle | null = null;

  while (true) {
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: nowFn() }), "utf8");
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      // Stale lock recovery
      try {
        const st = await stat(lockPath);
        const age = nowFn() - st.mtimeMs;
        if (age > LOCK_STALE_MS) {
          let lockPid: number | null = null;
          try {
            const raw = await readFile(lockPath, "utf8");
            lockPid = (JSON.parse(raw) as { pid?: number }).pid ?? null;
          } catch {
            lockPid = null;
          }
          const alive = lockPid ? await pidAlive(lockPid) : false;
          if (!alive) {
            await unlink(lockPath).catch(() => {});
            continue;
          }
        }
      } catch {
        // lock disappeared — retry acquire
        continue;
      }

      if (nowFn() - started > maxWaitMs) {
        throw new Error(`Timed out acquiring queue lock: ${lockPath}`);
      }
      await sleep(pollMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      await handle?.close();
    } catch {
      /* ignore */
    }
    await unlink(lockPath).catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getOutputSignature(p: string): Promise<OutputSignature | null> {
  try {
    const info = await stat(p);
    return info.size > 0 ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch {
    return null;
  }
}

async function hasNewPeerOutput(peer: InflightEntry): Promise<boolean> {
  const current = await getOutputSignature(peer.outputPath);
  if (!current) return false;
  const previous = peer.priorOutput;
  return !previous || current.size !== previous.size || current.mtimeMs !== previous.mtimeMs;
}

/**
 * Acquire a global slot for image generation, or join an in-flight duplicate.
 */
export async function acquireGlobalSlot(options: AcquireOptions): Promise<AcquireResult> {
  const {
    resourceKey,
    limits,
    maxWaitMs = DEFAULT_MAX_WAIT_MS,
    pollMs = DEFAULT_POLL_MS,
    now = Date.now,
  } = options;
  const outputPath = path.resolve(options.outputPath);
  const taskHash = options.taskHash;
  const { dir, statePath, lockPath } = pathsFor(resourceKey, options.queueRoot);
  await ensureDir(dir);

  const ownerToken = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const waitStarted = now();

  while (true) {
    if (now() - waitStarted > maxWaitMs) {
      throw new Error(
        `Timed out waiting for global image queue slot (${resourceKey}). output=${outputPath}`,
      );
    }

    const decision = await withFileLock(
      lockPath,
      async () => {
        let state = await pruneStale(await readState(statePath), now());

        // Dedup: same output path or same task hash already running
        const byOutput = state.inflight[`out:${outputPath}`];
        const byHash = state.inflight[`hash:${taskHash}`];
        const peer = byOutput || byHash;
        if (peer && peer.ownerToken !== ownerToken) {
          const alive = await pidAlive(peer.pid);
          if (alive) {
            await writeStateAtomic(statePath, state);
            return { type: "join" as const, peer };
          }
          // dead peer — drop
          delete state.inflight[`out:${peer.outputPath}`];
          delete state.inflight[`hash:${peer.taskHash}`];
        }

        if (state.cooldownUntil > now()) {
          await writeStateAtomic(statePath, state);
          return { type: "wait" as const, until: state.cooldownUntil };
        }

        const owners = new Set(Object.values(state.inflight).map((e) => e.ownerToken));
        const active = owners.size;
        const enoughCapacity = active < Math.max(1, limits.concurrency);
        const enoughGap = now() - state.lastStartedAt >= Math.max(0, limits.startIntervalMs);

        if (!enoughCapacity || !enoughGap) {
          await writeStateAtomic(statePath, state);
          return { type: "wait" as const, until: null };
        }

        const entry: InflightEntry = {
          pid: process.pid,
          outputPath,
          taskHash,
          startedAt: now(),
          ownerToken,
          priorOutput: await getOutputSignature(outputPath),
        };
        state.inflight[`out:${outputPath}`] = entry;
        state.inflight[`hash:${taskHash}`] = entry;
        state.active = active + 1;
        state.lastStartedAt = now();
        await writeStateAtomic(statePath, state);
        return { type: "run" as const };
      },
      { now, pollMs, maxWaitMs: Math.min(10_000, maxWaitMs) },
    );

    if (decision.type === "run") {
      const release = async (outcome: ReleaseOutcome): Promise<void> => {
        await withFileLock(
          lockPath,
          async () => {
            let state = await pruneStale(await readState(statePath), now());
            const existing = state.inflight[`out:${outputPath}`];
            if (existing && existing.ownerToken === ownerToken) {
              delete state.inflight[`out:${outputPath}`];
              delete state.inflight[`hash:${taskHash}`];
            }
            const owners = new Set(Object.values(state.inflight).map((e) => e.ownerToken));
            state.active = owners.size;

            const hit429 =
              outcome.kind === "error" &&
              (outcome.is429 === true ||
                outcome.status === 429 ||
                (outcome.message ? isRateLimitError(outcome.message) : false));

            if (hit429) {
              state.consecutive429 = (state.consecutive429 || 0) + 1;
              const cool = computeCooldownMs(state.consecutive429);
              state.cooldownUntil = Math.max(state.cooldownUntil, now() + cool);
              console.error(
                `[global-queue] 429 on ${resourceKey}; cooldown ${Math.round(cool / 1000)}s ` +
                  `(consecutive=${state.consecutive429}) until ${new Date(state.cooldownUntil).toISOString()}`,
              );
            } else if (outcome.kind === "success") {
              state.consecutive429 = 0;
              // Don't clear cooldown early if another process set a future one mid-flight
            }

            await writeStateAtomic(statePath, state);
          },
          { now, pollMs, maxWaitMs: 10_000 },
        );
      };
      return { mode: "run", release };
    }

    if (decision.type === "join") {
      const peerOut = decision.peer.outputPath;
      console.error(
        `[global-queue] Joining in-flight job pid=${decision.peer.pid} output=${peerOut} (dedup)`,
      );
      // Accept only an output written after this peer acquired the slot. A
      // pre-existing --image destination is an overwrite target, not a cache.
      while (true) {
        if (await hasNewPeerOutput(decision.peer)) return { mode: "joined", outputPath: peerOut };
        const still = await withFileLock(
          lockPath,
          async () => {
            const state = await pruneStale(await readState(statePath), now());
            const entry =
              state.inflight[`out:${peerOut}`] || state.inflight[`hash:${taskHash}`];
            await writeStateAtomic(statePath, state);
            return entry;
          },
          { now, pollMs, maxWaitMs: 10_000 },
        );
        if (!still) {
          // Peer finished without file (failed) — fall through to try acquiring ourselves
          if (await hasNewPeerOutput(decision.peer)) return { mode: "joined", outputPath: peerOut };
          break;
        }
        if (now() - waitStarted > maxWaitMs) {
          throw new Error(`Timed out waiting for deduped image job: ${peerOut}`);
        }
        await sleep(pollMs);
      }
      continue;
    }

    // wait
    if (decision.until) {
      const sleepFor = Math.min(pollMs * 4, Math.max(50, decision.until - now()));
      if (sleepFor > pollMs) {
        console.error(
          `[global-queue] Cooling down ${resourceKey} for ~${Math.ceil(sleepFor / 1000)}s`,
        );
      }
      await sleep(sleepFor);
    } else {
      await sleep(pollMs);
    }
  }
}

/** Test helper: reset queue state for a resource key. */
export async function resetQueueState(
  resourceKey: QueueResourceKey,
  queueRoot?: string,
): Promise<void> {
  const { dir } = pathsFor(resourceKey, queueRoot);
  await rm(dir, { recursive: true, force: true });
}

export async function readQueueState(
  resourceKey: QueueResourceKey,
  queueRoot?: string,
): Promise<QueueState> {
  const { statePath, dir } = pathsFor(resourceKey, queueRoot);
  await ensureDir(dir);
  return readState(statePath);
}
