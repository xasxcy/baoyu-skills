import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  VertexPool,
  parseVertexPoolConfig,
  getVertexPool,
  __resetVertexPoolForTests,
} from "./vertex-pool.ts";
import {
  buildVertexResourceKey,
  readQueueState,
  sanitizeResourceKey,
} from "../global-queue.ts";

function useEnv(t: TestContext, values: Record<string, string | null>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

const NODE_A = { account: "a@x.com", project: "proj-a", location: "global", weight: 1 };
const NODE_B = { account: "b@x.com", project: "proj-b", location: "global", weight: 1 };

// --- parseVertexPoolConfig -------------------------------------------------

test("parseVertexPoolConfig: precedence env JSON > VERTEX_PROJECT_IDS > extend", (t) => {
  useEnv(t, {
    VERTEX_POOL_CONFIG: JSON.stringify([NODE_A, NODE_B]),
    VERTEX_PROJECT_IDS: "ignored-1,ignored-2",
  });
  const nodes = parseVertexPoolConfig(process.env, {
    vertex_pool_config: JSON.stringify([{ project: "also-ignored" }]),
  });
  assert.equal(nodes?.length, 2);
  assert.equal(nodes?.[0].project, "proj-a");
  assert.equal(nodes?.[0].account, "a@x.com");
});

test("parseVertexPoolConfig: VERTEX_PROJECT_IDS expands to accountless nodes", (t) => {
  useEnv(t, { VERTEX_POOL_CONFIG: null, VERTEX_PROJECT_IDS: " p1 , p2 ,p3 " });
  const nodes = parseVertexPoolConfig(process.env, undefined);
  assert.deepEqual(
    nodes?.map((n) => n.project),
    ["p1", "p2", "p3"],
  );
  assert.equal(nodes?.every((n) => n.account === undefined), true);
  assert.equal(nodes?.every((n) => n.location === "global" && n.weight === 1), true);
});

test("parseVertexPoolConfig: reads EXTEND.md vertex_pool_config JSON string", (t) => {
  useEnv(t, { VERTEX_POOL_CONFIG: null, VERTEX_PROJECT_IDS: null });
  const nodes = parseVertexPoolConfig(process.env, {
    vertex_pool_config: JSON.stringify([NODE_A]),
  });
  assert.equal(nodes?.length, 1);
  assert.equal(nodes?.[0].project, "proj-a");
});

test("parseVertexPoolConfig: null when nothing configured", (t) => {
  useEnv(t, { VERTEX_POOL_CONFIG: null, VERTEX_PROJECT_IDS: null });
  assert.equal(parseVertexPoolConfig(process.env, {}), null);
  assert.equal(parseVertexPoolConfig(process.env, undefined), null);
});

test("parseVertexPoolConfig: throws on malformed input (no silent fallback)", (t) => {
  useEnv(t, { VERTEX_POOL_CONFIG: "{not json", VERTEX_PROJECT_IDS: null });
  assert.throws(() => parseVertexPoolConfig(process.env), /not valid JSON/);

  useEnv(t, { VERTEX_POOL_CONFIG: JSON.stringify([{ location: "global" }]) });
  assert.throws(() => parseVertexPoolConfig(process.env), /missing "project"/);

  useEnv(t, { VERTEX_POOL_CONFIG: "[]" });
  assert.throws(() => parseVertexPoolConfig(process.env), /empty array/);

  useEnv(t, { VERTEX_POOL_CONFIG: JSON.stringify({ project: "x" }) });
  assert.throws(() => parseVertexPoolConfig(process.env), /must be a JSON array/);

  useEnv(t, {
    VERTEX_POOL_CONFIG: JSON.stringify([
      { id: "dup", project: "p1" },
      { id: "dup", project: "p2" },
    ]),
  });
  assert.throws(() => parseVertexPoolConfig(process.env), /duplicate node id/);
});

// --- VertexPool.nextHealthyNode -----------------------------------------

test("nextHealthyNode: round-robin rotates across available nodes", () => {
  const pool = new VertexPool(
    parseVertexPoolConfig({ VERTEX_POOL_CONFIG: JSON.stringify([NODE_A, NODE_B]) } as any)!,
    "round-robin",
  );
  const picks = [0, 1, 2, 3].map(() => pool.nextHealthyNode(0)!.project);
  assert.deepEqual(picks, ["proj-a", "proj-b", "proj-a", "proj-b"]);
});

test("nextHealthyNode: skips cooling and excluded nodes; null when none", () => {
  const pool = new VertexPool(
    parseVertexPoolConfig({ VERTEX_POOL_CONFIG: JSON.stringify([NODE_A, NODE_B]) } as any)!,
    "round-robin",
    60_000,
  );
  pool.markCooldown(`a@x.com::proj-a::global`, 0);
  assert.equal(pool.nextHealthyNode(1_000)!.project, "proj-b"); // cursor -> 1

  const excl = new Set(["b@x.com::proj-b::global"]);
  assert.equal(pool.nextHealthyNode(1_000, excl), null); // a cooling, b excluded

  // cooldown expired: both available again; shared cursor (now 1) picks index 1
  assert.equal(pool.nextHealthyNode(120_000)!.project, "proj-b");
  assert.equal(pool.nextHealthyNode(120_000)!.project, "proj-a");
});

test("nextHealthyNode: weighted-random honors weights with injected rng", () => {
  const nodes = parseVertexPoolConfig({
    VERTEX_POOL_CONFIG: JSON.stringify([
      { project: "light", weight: 1 },
      { project: "heavy", weight: 9 },
    ]),
  } as any)!;
  let r = 0;
  const pool = new VertexPool(nodes, "weighted-random", 60_000, () => r);
  r = 0.05; // 0.5 of total 10 → falls in first bucket (weight 1)
  assert.equal(pool.nextHealthyNode(0)!.project, "light");
  r = 0.5; // 5.0 of 10 → second bucket
  assert.equal(pool.nextHealthyNode(0)!.project, "heavy");
});

test("markCooldown: takes the max of existing and new deadline", () => {
  const pool = new VertexPool(
    parseVertexPoolConfig({ VERTEX_POOL_CONFIG: JSON.stringify([NODE_A]) } as any)!,
    "round-robin",
    60_000,
  );
  const id = "a@x.com::proj-a::global";
  pool.markCooldown(id, 1_000); // -> 61_000
  pool.markCooldown(id, 500); // -> would be 60_500, but max keeps 61_000
  assert.equal(pool.nextHealthyNode(60_800, undefined), null);
  assert.equal(pool.nextHealthyNode(61_001)!.project, "proj-a");
});

// --- syncCooldownFromQueue / prewarm ----------------------------------

test("syncCooldownFromQueue: persisted cooldown (120s) overrides shorter local (60s)", async (t) => {
  const queueRoot = await fs.mkdtemp(path.join(os.tmpdir(), "vpool-q-"));
  t.after(() => fs.rm(queueRoot, { recursive: true, force: true }));

  const nodes = parseVertexPoolConfig({
    VERTEX_POOL_CONFIG: JSON.stringify([NODE_A]),
  } as any)!;
  const pool = new VertexPool(nodes, "round-robin", 60_000);
  const id = "a@x.com::proj-a::global";
  const key = buildVertexResourceKey({
    projectId: "proj-a",
    location: "global",
    model: "m",
  });

  // Seed a persisted cooldown 120s in the "future" (relative to now=0 in test).
  const st = await readQueueState(key, queueRoot); // also creates the dir
  st.cooldownUntil = 120_000;
  await fs.writeFile(
    path.join(queueRoot, sanitizeResourceKey(key), "state.json"),
    JSON.stringify(st),
  );

  pool.markCooldown(id, 0); // local -> 60_000
  await pool.syncCooldownFromQueue(id, key, queueRoot);

  // At t=61s the local cooldown would have expired, but the persisted 120s wins.
  assert.equal(pool.nextHealthyNode(61_000), null);
  assert.equal(pool.nextHealthyNode(121_000)!.project, "proj-a");
});

// --- getVertexPool singleton -----------------------------------------

test("getVertexPool: same config returns same instance; cursor/cooldown persist", (t) => {
  __resetVertexPoolForTests();
  useEnv(t, {
    VERTEX_POOL_CONFIG: JSON.stringify([NODE_A, NODE_B]),
    VERTEX_PROJECT_IDS: null,
    VERTEX_POOL_ROUTING: "round-robin",
  });
  const p1 = getVertexPool(process.env, undefined);
  assert.ok(p1);
  assert.equal(p1!.nextHealthyNode(0)!.project, "proj-a");

  const p2 = getVertexPool(process.env, undefined);
  assert.equal(p1, p2); // same instance
  // cursor advanced on p1 is visible via p2
  assert.equal(p2!.nextHealthyNode(0)!.project, "proj-b");

  t.after(() => __resetVertexPoolForTests());
});

test("getVertexPool: rebuilds when config fingerprint changes; null when unset", (t) => {
  __resetVertexPoolForTests();
  useEnv(t, { VERTEX_POOL_CONFIG: JSON.stringify([NODE_A]), VERTEX_PROJECT_IDS: null });
  const p1 = getVertexPool(process.env);
  useEnv(t, { VERTEX_POOL_CONFIG: JSON.stringify([NODE_A, NODE_B]) });
  const p2 = getVertexPool(process.env);
  assert.notEqual(p1, p2);
  assert.equal(p2!.size, 2);

  useEnv(t, { VERTEX_POOL_CONFIG: null });
  assert.equal(getVertexPool(process.env), null);
  t.after(() => __resetVertexPoolForTests());
});

test("dedupKey is stable regardless of node order", () => {
  const a = new VertexPool(
    parseVertexPoolConfig({ VERTEX_POOL_CONFIG: JSON.stringify([NODE_A, NODE_B]) } as any)!,
  );
  const b = new VertexPool(
    parseVertexPoolConfig({ VERTEX_POOL_CONFIG: JSON.stringify([NODE_B, NODE_A]) } as any)!,
  );
  assert.equal(a.dedupKey("m"), b.dedupKey("m"));
  assert.equal(a.dedupKey("m"), "vertexpool:proj-a,proj-b|m");
});
