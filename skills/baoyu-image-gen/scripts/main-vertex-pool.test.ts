import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CliArgs } from "./types.ts";
import { generatePooledVertexTask, type PreparedTask } from "./main.ts";
import { VertexPool, parseVertexPoolConfig } from "./providers/vertex-pool.ts";
import {
  acquireGlobalSlot,
  buildVertexResourceKey,
  readQueueState,
  sanitizeResourceKey,
} from "./global-queue.ts";

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

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: "a red circle",
    promptFiles: [],
    imagePath: null,
    provider: "vertex",
    model: null,
    aspectRatio: null,
    size: null,
    quality: "2k",
    imageSize: null,
    imageApiDialect: null,
    referenceImages: [],
    n: 1,
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
    ...overrides,
  };
}

const MODEL = "gemini-3.1-flash-image";

async function setupQueue(t: TestContext): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vpool-main-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeTask(t: TestContext, id = "t1"): Promise<PreparedTask> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vpool-out-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return {
    id,
    prompt: "a red circle",
    args: makeArgs(),
    provider: "vertex",
    model: MODEL,
    outputPath: path.join(dir, `${id}.png`),
    providerModule: {} as any,
  };
}

function twoNodePool(): VertexPool {
  const nodes = parseVertexPoolConfig({
    VERTEX_POOL_CONFIG: JSON.stringify([
      { id: "n1", project: "proj-1", location: "global" },
      { id: "n2", project: "proj-2", location: "global" },
    ]),
  } as any)!;
  return new VertexPool(nodes, "round-robin", 60_000);
}

function inlineImage(text: string): Response {
  return Response.json([
    {
      candidates: [
        { content: { parts: [{ inlineData: { data: Buffer.from(text).toString("base64") } }] } },
      ],
    },
  ]);
}

function projectOf(url: string): string {
  return url.match(/\/projects\/([^/]+)\//)?.[1] ?? "?";
}

const LIMITS = { concurrency: 4, startIntervalMs: 0 };

function fakeDeps(startNow = 0) {
  const state = { now: startNow, sleeps: [] as number[] };
  return {
    state,
    deps: {
      now: () => state.now,
      sleep: async (ms: number) => {
        state.sleeps.push(ms);
        state.now += ms;
      },
      maxWaitMs: 3_600_000,
    },
  };
}

test("pool: round-robin spreads calls across nodes", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, {
    VERTEX_BEARER_TOKEN: "tok",
    VERTEX_POOL_ALLOW_STATIC_TOKEN: null,
    BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot,
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(projectOf(String(input)));
    return inlineImage("ok");
  };

  const pool = twoNodePool();
  for (let i = 0; i < 4; i++) {
    const res = await generatePooledVertexTask(await makeTask(t, `rr${i}`), pool, LIMITS, true, fakeDeps().deps);
    assert.equal(res.success, true, res.error ?? "");
  }
  assert.deepEqual(seen, ["proj-1", "proj-2", "proj-1", "proj-2"]);
});

test("pool: 429 on node 1 transparently fails over to node 2 in the same attempt", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const p = projectOf(String(input));
    seen.push(p);
    if (p === "proj-1") return new Response("RESOURCE_EXHAUSTED", { status: 429 });
    return inlineImage("ok-2");
  };

  const pool = twoNodePool();
  const { deps } = fakeDeps();
  const res = await generatePooledVertexTask(await makeTask(t, "fo"), pool, LIMITS, true, deps);

  assert.equal(res.success, true, res.error ?? "");
  assert.equal(res.attempts, 1); // single outer attempt
  assert.deepEqual(seen, ["proj-1", "proj-2"]);
  // node 1 is now cooling
  assert.equal(pool.nextHealthyNode(deps.now())?.project, "proj-2");
});

test("pool: permanent 400 does not fail over and returns failure", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response("bad request", { status: 400 });
  };

  const res = await generatePooledVertexTask(await makeTask(t, "perm"), twoNodePool(), LIMITS, true, fakeDeps().deps);
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /Vertex AI error \(400\)/);
  assert.equal(calls, 1); // no failover to node 2
});

test("pool: each node tried at most once per attempt; outer loop retries up to MAX_ATTEMPTS", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    seen.push(projectOf(String(input)));
    return new Response("RESOURCE_EXHAUSTED", { status: 429 });
  };

  const { deps, state } = fakeDeps();
  const res = await generatePooledVertexTask(await makeTask(t, "ex"), twoNodePool(), LIMITS, true, deps);

  assert.equal(res.success, false);
  assert.equal(res.attempts, 3); // MAX_ATTEMPTS outer cycles
  // 2 distinct nodes per attempt, 3 attempts → 6 calls, never the same node twice within an attempt
  assert.deepEqual(seen, ["proj-1", "proj-2", "proj-1", "proj-2", "proj-1", "proj-2"]);
  // at least the two inter-attempt backoffs happened (plus bounded cooldown polling)
  assert.ok(state.sleeps.length >= 2, `expected >=2 sleeps, got ${state.sleeps.length}`);
});

test("pool: all nodes cooling → bounded wait, then succeeds (no spurious failure)", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });

  // Seed persisted cooldown for both node resource keys at epoch 5000.
  for (const project of ["proj-1", "proj-2"]) {
    const key = buildVertexResourceKey({ projectId: project, location: "global", model: MODEL });
    const st = await readQueueState(key, queueRoot);
    st.cooldownUntil = 5000;
    await fs.writeFile(path.join(queueRoot, sanitizeResourceKey(key), "state.json"), JSON.stringify(st));
  }

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => inlineImage("late-ok");

  const { deps, state } = fakeDeps(0);
  const res = await generatePooledVertexTask(await makeTask(t, "cool"), twoNodePool(), LIMITS, true, deps);

  assert.equal(res.success, true, res.error ?? "");
  assert.ok(state.sleeps.length >= 1, "should have waited for cooldown");
  assert.ok(state.now >= 5000, "clock advanced past the persisted cooldown");
});

test("pool: cooldown beyond the wait budget fails fast with a clear message", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });
  for (const project of ["proj-1", "proj-2"]) {
    const key = buildVertexResourceKey({ projectId: project, location: "global", model: MODEL });
    const st = await readQueueState(key, queueRoot);
    st.cooldownUntil = 999_999;
    await fs.writeFile(path.join(queueRoot, sanitizeResourceKey(key), "state.json"), JSON.stringify(st));
  }
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => inlineImage("never");

  const deps = { now: () => 0, sleep: async () => {}, maxWaitMs: 1000 };
  const res = await generatePooledVertexTask(await makeTask(t, "budget"), twoNodePool(), LIMITS, true, deps);
  assert.equal(res.success, false);
  assert.match(res.error ?? "", /cooling down/i);
});

test("pool: L2 node-slot wait is bounded by the remaining L1 lifetime, not the queue default", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });

  const tightLimits = { concurrency: 1, startIntervalMs: 0 };
  const pool = twoNodePool();

  // Occupy both nodes' single concurrency slot from "another process" so our
  // task's L2 acquisition has to wait — and never releases during the test.
  const foreignOutDir = await fs.mkdtemp(path.join(os.tmpdir(), "vpool-foreign-"));
  t.after(() => fs.rm(foreignOutDir, { recursive: true, force: true }));
  for (const project of ["proj-1", "proj-2"]) {
    const key = buildVertexResourceKey({ projectId: project, location: "global", model: MODEL });
    await acquireGlobalSlot({
      resourceKey: key,
      outputPath: path.join(foreignOutDir, `${project}.png`),
      taskHash: `foreign-${project}`,
      limits: tightLimits,
    }); // never released — simulates sustained contention
  }

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => inlineImage("unreachable"); // should never be called

  const start = Date.now();
  const deps = { now: () => Date.now(), sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)), maxWaitMs: 2_000 };
  const res = await generatePooledVertexTask(await makeTask(t, "bounded"), pool, tightLimits, true, deps);
  const elapsedMs = Date.now() - start;

  assert.equal(res.success, false);
  assert.ok(
    elapsedMs < 8_000,
    `expected the bounded L2 wait to fail well under the queue's 30min default, took ${elapsedMs}ms`,
  );

  // L1 was released on failure — a fresh identical task can immediately claim it
  // instead of finding a stale/leaked ownership entry.
  const st = await readQueueState(pool.dedupKey(MODEL), queueRoot);
  assert.equal(Object.keys(st.inflight).length, 0, "L1 ownership must not leak after failure");
});

test("pool: failover still works with the global queue disabled (no queue dir)", async (t) => {
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: null });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const seen: string[] = [];
  globalThis.fetch = async (input) => {
    const p = projectOf(String(input));
    seen.push(p);
    if (p === "proj-1") return new Response("RESOURCE_EXHAUSTED", { status: 429 });
    return inlineImage("ok-2");
  };

  const res = await generatePooledVertexTask(
    await makeTask(t, "nq"),
    twoNodePool(),
    LIMITS,
    false, // useGlobalQueue = false
    fakeDeps().deps,
  );
  assert.equal(res.success, true, res.error ?? "");
  assert.deepEqual(seen, ["proj-1", "proj-2"]); // in-process failover intact
});

test("pool: concurrent identical tasks dedupe via the L1 ownership lock", async (t) => {
  const queueRoot = await setupQueue(t);
  useEnv(t, { VERTEX_BEARER_TOKEN: "tok", BAOYU_IMAGE_GEN_QUEUE_DIR: queueRoot });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  let calls = 0;
  let started!: () => void;
  const didStart = new Promise<void>((r) => (started = r));
  let gate!: () => void;
  const waitGate = new Promise<void>((r) => (gate = r));
  globalThis.fetch = async () => {
    calls += 1;
    started();
    await waitGate;
    return inlineImage("shared");
  };

  const pool = twoNodePool();
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "vpool-dup-"));
  t.after(() => fs.rm(outDir, { recursive: true, force: true }));
  const mk = (id: string): PreparedTask => ({
    id: "dup", // identical logical task → identical taskHash
    prompt: "a red circle",
    args: makeArgs(),
    provider: "vertex",
    model: MODEL,
    outputPath: path.join(outDir, `${id}.png`),
    providerModule: {} as any,
  });

  const a = generatePooledVertexTask(mk("first"), pool, LIMITS, true, fakeDeps().deps);
  await didStart; // A is in-flight before B tries to acquire
  const b = generatePooledVertexTask(mk("second"), pool, LIMITS, true, fakeDeps().deps);
  await new Promise((r) => setTimeout(r, 60));
  gate();
  const [ra, rb] = await Promise.all([a, b]);

  assert.equal(ra.success, true, ra.error ?? "");
  assert.equal(rb.success, true, rb.error ?? "");
  assert.equal(calls, 1); // B joined A's in-flight generation
  assert.deepEqual(
    await fs.readFile(path.join(outDir, "first.png")),
    await fs.readFile(path.join(outDir, "second.png")),
  );
});
