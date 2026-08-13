import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  acquireGlobalSlot,
  buildVertexResourceKey,
  computeCooldownMs,
  computeRetryDelayMs,
  computeTaskHash,
  isRateLimitError,
  readQueueState,
  resetQueueState,
} from "./global-queue.ts";

test("retry delay uses truncated exponential ranges with jitter", () => {
  const d1 = computeRetryDelayMs(1, { random: () => 0 });
  const d1hi = computeRetryDelayMs(1, { random: () => 0.999 });
  assert.ok(d1 >= 2000 && d1 <= 4000);
  assert.ok(d1hi >= 2000 && d1hi <= 4000);

  const d2 = computeRetryDelayMs(2, { random: () => 0.5 });
  assert.ok(d2 >= 8000 && d2 <= 12000);

  const d3 = computeRetryDelayMs(3, { random: () => 0.5 });
  assert.ok(d3 >= 30000 && d3 <= 45000);
});

test("cooldown expands on consecutive 429s and caps", () => {
  assert.equal(computeCooldownMs(1), 60_000);
  assert.equal(computeCooldownMs(2), 120_000);
  assert.equal(computeCooldownMs(3), 240_000);
  assert.equal(computeCooldownMs(10), 15 * 60_000);
});

test("isRateLimitError detects Vertex 429 payloads", () => {
  assert.equal(isRateLimitError(new Error("Vertex AI error (429): RESOURCE_EXHAUSTED")), true);
  assert.equal(isRateLimitError(new Error("API error (500): boom")), false);
});

test("task hash is stable for equivalent requests, ignores destination, and changes with prompt", () => {
  const a = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello",
  });
  const b = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello",
  });
  const c = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello2",
  });
  const differentDestination = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello",
  });
  const differentExplicitSize = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello",
    size: "2048x2048",
  });
  const reversedReferences = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello",
    referenceImages: ["/tmp/second.png", "/tmp/first.png"],
  });
  const orderedReferences = computeTaskHash({
    provider: "vertex",
    model: "gemini-3.1-flash-image",
    prompt: "hello",
    referenceImages: ["/tmp/first.png", "/tmp/second.png"],
  });
  assert.equal(a, b);
  assert.equal(a, differentDestination);
  assert.notEqual(a, c);
  assert.notEqual(a, differentExplicitSize);
  assert.notEqual(reversedReferences, orderedReferences);
});

test("global queue does not treat a pre-existing output as an in-flight result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baoyu-q-existing-"));
  const key = "test:existing";
  const out = path.join(root, "existing.png");
  await fs.writeFile(out, "old-image");

  const slot = await acquireGlobalSlot({
    resourceKey: key,
    outputPath: out,
    taskHash: "fresh-generation",
    limits: { concurrency: 1, startIntervalMs: 0 },
    queueRoot: root,
    pollMs: 20,
    maxWaitMs: 1000,
  });
  assert.equal(slot.mode, "run");
  if (slot.mode === "run") await slot.release({ kind: "success" });
});

test("global queue serializes concurrency=1 and records 429 cooldown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baoyu-q-"));
  const key = buildVertexResourceKey({
    projectId: "test-proj",
    location: "global",
    model: "gemini-3.1-flash-image",
  });
  await resetQueueState(key, root);

  const outA = path.join(root, "a.png");
  const outB = path.join(root, "b.png");
  const limits = { concurrency: 1, startIntervalMs: 0 };

  const slotA = await acquireGlobalSlot({
    resourceKey: key,
    outputPath: outA,
    taskHash: "hash-a",
    limits,
    queueRoot: root,
    pollMs: 50,
    maxWaitMs: 5000,
  });
  assert.equal(slotA.mode, "run");

  let bResolved = false;
  const slotBPromise = acquireGlobalSlot({
    resourceKey: key,
    outputPath: outB,
    taskHash: "hash-b",
    limits,
    queueRoot: root,
    pollMs: 50,
    maxWaitMs: 5000,
  }).then((s) => {
    bResolved = true;
    return s;
  });

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(bResolved, false, "second acquire must wait while first holds the slot");

  if (slotA.mode !== "run") throw new Error("expected run");
  await slotA.release({ kind: "error", is429: true, status: 429, message: "429 RESOURCE_EXHAUSTED" });

  const stateAfter429 = await readQueueState(key, root);
  assert.ok(stateAfter429.cooldownUntil > Date.now() - 1000);
  assert.equal(stateAfter429.consecutive429, 1);

  // Force cooldown cleared so B can proceed in this unit test
  const statePath = path.join(root, key.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 180), "state.json");
  const raw = JSON.parse(await fs.readFile(statePath, "utf8")) as {
    cooldownUntil: number;
    consecutive429: number;
  };
  raw.cooldownUntil = 0;
  await fs.writeFile(statePath, JSON.stringify(raw, null, 2));

  const slotB = await slotBPromise;
  assert.equal(slotB.mode, "run");
  if (slotB.mode === "run") {
    await fs.writeFile(outB, "ok");
    await slotB.release({ kind: "success" });
  }

  const finalState = await readQueueState(key, root);
  assert.equal(finalState.consecutive429, 0);
  assert.equal(Object.keys(finalState.inflight).length, 0);
});

test("global queue dedups same output path by joining in-flight peer", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baoyu-q-dedup-"));
  const key = "test:dedup";
  await resetQueueState(key, root);
  const out = path.join(root, "shared.png");
  const limits = { concurrency: 1, startIntervalMs: 0 };

  const first = await acquireGlobalSlot({
    resourceKey: key,
    outputPath: out,
    taskHash: "same-hash",
    limits,
    queueRoot: root,
    pollMs: 40,
    maxWaitMs: 5000,
  });
  assert.equal(first.mode, "run");

  const joinPromise = acquireGlobalSlot({
    resourceKey: key,
    outputPath: out,
    taskHash: "same-hash",
    limits,
    queueRoot: root,
    pollMs: 40,
    maxWaitMs: 5000,
  });

  await new Promise((r) => setTimeout(r, 120));
  if (first.mode !== "run") throw new Error("expected run");
  await fs.writeFile(out, Buffer.from("image-bytes"));
  await first.release({ kind: "success" });

  const joined = await joinPromise;
  assert.equal(joined.mode, "joined");
  if (joined.mode === "joined") {
    assert.equal(path.resolve(joined.outputPath), path.resolve(out));
  }
});

test("global queue ignores a stale output until its in-flight peer overwrites it", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "baoyu-q-stale-"));
  const key = "test:stale-output";
  const out = path.join(root, "shared.png");
  await fs.writeFile(out, "old-image");
  const limits = { concurrency: 1, startIntervalMs: 0 };

  const first = await acquireGlobalSlot({
    resourceKey: key,
    outputPath: out,
    taskHash: "same-task",
    limits,
    queueRoot: root,
    pollMs: 20,
    maxWaitMs: 2000,
  });
  assert.equal(first.mode, "run");

  let joined = false;
  const secondPromise = acquireGlobalSlot({
    resourceKey: key,
    outputPath: out,
    taskHash: "same-task",
    limits,
    queueRoot: root,
    pollMs: 20,
    maxWaitMs: 2000,
  }).then((result) => {
    joined = true;
    return result;
  });

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(joined, false, "a stale output must not satisfy an in-flight join");
  await fs.writeFile(out, "new-image-content");
  if (first.mode === "run") await first.release({ kind: "success" });

  const second = await secondPromise;
  assert.equal(second.mode, "joined");
  assert.equal(await fs.readFile(out, "utf8"), "new-image-content");
});
