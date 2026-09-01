/**
 * Vertex AI multi-account / multi-project rotation pool.
 *
 * Scheduling lives in main.ts `generatePreparedTask` (see
 * workspace/dev/2026-09-01-baoyu-image-gen-multi-account-vertex/PLAN_V3.md).
 * This module only owns:
 *   - parsing the pool config (env / EXTEND.md),
 *   - a process-level singleton pool with a round-robin / weighted-random
 *     cursor and per-node cooldown,
 *   - syncing each node's cooldown from the cross-process global queue state
 *     so a node cooling in another process is skipped here too.
 *
 * The pool never performs network calls or acquires queue slots itself.
 */

import type { ExtendConfig } from "../types";
import { buildVertexResourceKey, readQueueState } from "../global-queue";

export interface VertexNodeConfig {
  id?: string;
  account?: string;
  project: string;
  location?: string;
  weight?: number;
}

export interface VertexNode {
  id: string;
  account?: string;
  project: string;
  location: string;
  weight: number;
  /** epoch ms; node is unavailable while `Date.now() < cooldownUntil` */
  cooldownUntil: number;
}

export interface VertexExecContext {
  project: string;
  location: string;
  account?: string;
}

export type VertexRouting = "round-robin" | "weighted-random";

const DEFAULT_LOCATION = "global";
const DEFAULT_COOLDOWN_MS = 60_000;

function normalizeNode(raw: unknown, index: number): VertexNode {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Vertex pool node #${index} is not an object`);
  }
  const cfg = raw as Record<string, unknown>;
  const project = typeof cfg.project === "string" ? cfg.project.trim() : "";
  if (!project) {
    throw new Error(`Vertex pool node #${index} is missing "project"`);
  }
  const account =
    typeof cfg.account === "string" && cfg.account.trim() ? cfg.account.trim() : undefined;
  const location =
    typeof cfg.location === "string" && cfg.location.trim()
      ? cfg.location.trim()
      : DEFAULT_LOCATION;
  const weightRaw = typeof cfg.weight === "number" ? cfg.weight : Number(cfg.weight);
  const weight = Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1;
  const id =
    typeof cfg.id === "string" && cfg.id.trim()
      ? cfg.id.trim()
      : `${account ?? "default"}::${project}::${location}`;
  return { id, account, project, location, weight, cooldownUntil: 0 };
}

function parseNodeArray(value: unknown, source: string): VertexNode[] {
  if (!Array.isArray(value)) {
    throw new Error(`Vertex pool config from ${source} must be a JSON array`);
  }
  const nodes = value.map((raw, i) => normalizeNode(raw, i));
  if (nodes.length === 0) {
    throw new Error(`Vertex pool config from ${source} is an empty array`);
  }
  // Reject duplicate ids so round-robin / cooldown bookkeeping stays 1:1.
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.id)) {
      throw new Error(`Vertex pool has duplicate node id "${n.id}"`);
    }
    seen.add(n.id);
  }
  return nodes;
}

function parseJsonNodes(text: string, source: string): VertexNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Vertex pool config from ${source} is not valid JSON: ${msg}`);
  }
  return parseNodeArray(parsed, source);
}

/**
 * Resolve pool nodes from (highest precedence first):
 *   1. env.VERTEX_POOL_CONFIG        JSON array
 *   2. env.VERTEX_PROJECT_IDS        comma-separated project ids (current gcloud account)
 *   3. extend.vertex_pool_config     JSON string (array)
 * Returns null when none are set (caller falls back to the single-node path).
 * Throws on malformed input rather than silently falling back.
 */
export function parseVertexPoolConfig(
  env: NodeJS.ProcessEnv = process.env,
  extend?: Partial<ExtendConfig>,
): VertexNode[] | null {
  const poolConfig = env.VERTEX_POOL_CONFIG?.trim();
  if (poolConfig) {
    return parseJsonNodes(poolConfig, "VERTEX_POOL_CONFIG");
  }

  const projectIds = env.VERTEX_PROJECT_IDS?.trim();
  if (projectIds) {
    const ids = projectIds
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length === 0) {
      throw new Error("VERTEX_PROJECT_IDS is set but contains no project ids");
    }
    return parseNodeArray(
      ids.map((project) => ({ project })),
      "VERTEX_PROJECT_IDS",
    );
  }

  const extendConfig = extend?.vertex_pool_config?.trim();
  if (extendConfig) {
    return parseJsonNodes(extendConfig, "EXTEND.md vertex_pool_config");
  }

  return null;
}

function resolveRouting(
  env: NodeJS.ProcessEnv,
  extend?: Partial<ExtendConfig>,
): VertexRouting {
  const raw = (env.VERTEX_POOL_ROUTING || extend?.vertex_pool_routing || "").trim();
  return raw === "weighted-random" ? "weighted-random" : "round-robin";
}

function resolveCooldownMs(
  env: NodeJS.ProcessEnv,
  extend?: Partial<ExtendConfig>,
): number {
  const rawEnv = env.VERTEX_POOL_COOLDOWN_SECONDS?.trim();
  const seconds = rawEnv
    ? Number(rawEnv)
    : typeof extend?.vertex_pool_cooldown_seconds === "number"
      ? extend.vertex_pool_cooldown_seconds
      : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_COOLDOWN_MS;
}

export class VertexPool {
  readonly size: number;
  private readonly nodes: VertexNode[];
  private readonly routing: VertexRouting;
  private readonly localCooldownMs: number;
  private readonly random: () => number;
  private cursor = 0;

  constructor(
    nodes: VertexNode[],
    routing: VertexRouting = "round-robin",
    localCooldownMs: number = DEFAULT_COOLDOWN_MS,
    random: () => number = Math.random,
  ) {
    if (nodes.length === 0) throw new Error("VertexPool requires at least one node");
    this.nodes = nodes;
    this.size = nodes.length;
    this.routing = routing;
    this.localCooldownMs = localCooldownMs;
    this.random = random;
  }

  private byId(nodeId: string): VertexNode {
    const node = this.nodes.find((n) => n.id === nodeId);
    if (!node) throw new Error(`Unknown Vertex pool node id "${nodeId}"`);
    return node;
  }

  /** Next node whose cooldown has expired and is not in `exclude`; null if none. */
  nextHealthyNode(now: number = Date.now(), exclude?: Set<string>): VertexNode | null {
    const available = this.nodes.filter(
      (n) => n.cooldownUntil <= now && !exclude?.has(n.id),
    );
    if (available.length === 0) return null;

    if (this.routing === "weighted-random") {
      const total = available.reduce((sum, n) => sum + n.weight, 0);
      let pick = this.random() * total;
      for (const n of available) {
        pick -= n.weight;
        if (pick <= 0) return n;
      }
      return available[available.length - 1];
    }

    // round-robin: shared cursor over the currently-available slice
    const node = available[this.cursor % available.length];
    this.cursor += 1;
    return node;
  }

  markCooldown(nodeId: string, now: number = Date.now()): void {
    const node = this.byId(nodeId);
    node.cooldownUntil = Math.max(node.cooldownUntil, now + this.localCooldownMs);
  }

  /** Pull the persisted (possibly exponential) cooldown for this node's queue key. */
  async syncCooldownFromQueue(
    nodeId: string,
    resourceKey: string,
    queueRoot?: string,
  ): Promise<void> {
    const node = this.byId(nodeId);
    try {
      const state = await readQueueState(resourceKey, queueRoot);
      if (typeof state.cooldownUntil === "number") {
        node.cooldownUntil = Math.max(node.cooldownUntil, state.cooldownUntil);
      }
    } catch {
      // Missing / unreadable state == no persisted cooldown; leave node as-is.
    }
  }

  /** Sync every node's cooldown from the global queue for the given model. */
  async prewarm(model: string, queueRoot?: string): Promise<void> {
    await Promise.all(
      this.nodes.map((n) =>
        this.syncCooldownFromQueue(
          n.id,
          buildVertexResourceKey({ projectId: n.project, location: n.location, model }),
          queueRoot,
        ),
      ),
    );
  }

  /** Earliest epoch-ms at which some (non-excluded) node becomes available. */
  earliestCooldownUntil(exclude?: Set<string>): number {
    const candidates = this.nodes.filter((n) => !exclude?.has(n.id));
    if (candidates.length === 0) return Number.POSITIVE_INFINITY;
    return Math.min(...candidates.map((n) => Math.max(0, n.cooldownUntil)));
  }

  ctxFor(node: VertexNode): VertexExecContext {
    return { project: node.project, location: node.location, account: node.account };
  }

  resourceKeyFor(node: VertexNode, model: string): string {
    return buildVertexResourceKey({
      projectId: node.project,
      location: node.location,
      model,
    });
  }

  /** Stable key for the pool-wide ownership/dedup lock (independent of node). */
  dedupKey(model: string): string {
    const projects = this.nodes
      .map((n) => n.project)
      .slice()
      .sort()
      .join(",");
    return `vertexpool:${projects}|${model}`;
  }

  snapshotForLog(now: number = Date.now()): Array<{
    id: string;
    project: string;
    account: string;
    coolMsLeft: number;
  }> {
    return this.nodes.map((n) => ({
      id: n.id,
      project: n.project,
      account: n.account ?? "(gcloud-default)",
      coolMsLeft: Math.max(0, n.cooldownUntil - now),
    }));
  }
}

// --- process-level singleton -------------------------------------------------

let cached: { fingerprint: string; pool: VertexPool } | null = null;

function fingerprintOf(
  nodes: VertexNode[],
  routing: VertexRouting,
  cooldownMs: number,
): string {
  return JSON.stringify({
    nodes: nodes.map((n) => ({
      id: n.id,
      account: n.account ?? null,
      project: n.project,
      location: n.location,
      weight: n.weight,
    })),
    routing,
    cooldownMs,
  });
}

/**
 * Return the process-wide pool for the current config, or null if no pool is
 * configured. Rebuilds only when the resolved config changes; the returned
 * instance keeps its round-robin cursor and cooldown across tasks.
 */
export function getVertexPool(
  env: NodeJS.ProcessEnv = process.env,
  extend?: Partial<ExtendConfig>,
  random: () => number = Math.random,
): VertexPool | null {
  const nodes = parseVertexPoolConfig(env, extend);
  if (!nodes) {
    cached = null;
    return null;
  }
  const routing = resolveRouting(env, extend);
  const cooldownMs = resolveCooldownMs(env, extend);
  const fingerprint = fingerprintOf(nodes, routing, cooldownMs);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.pool;
  }
  const pool = new VertexPool(nodes, routing, cooldownMs, random);
  cached = { fingerprint, pool };
  return pool;
}

/** Test hook: drop the singleton so the next getVertexPool() rebuilds. */
export function __resetVertexPoolForTests(): void {
  cached = null;
}
