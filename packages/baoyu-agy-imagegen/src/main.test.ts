import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotRefs, resolveGenerationFromRun } from "./main.ts";
import { cacheKey } from "./cache.ts";
import { JsonLogger } from "./logger.ts";
import { GenError } from "./types.ts";
import type { AgyRunResult } from "./types.ts";

test("snapshotRefs copies each ref's current bytes to a private path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const a = path.join(dir, "a.jpg");
    const b = path.join(dir, "b.png");
    await writeFile(a, "content-a");
    await writeFile(b, "content-b");

    const { paths, cleanup } = await snapshotRefs([a, b]);
    try {
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(a);
      expect(paths[1]).not.toBe(b);
      expect((await readFile(paths[0], "utf-8"))).toBe("content-a");
      expect((await readFile(paths[1], "utf-8"))).toBe("content-b");

      // Mutating the original after snapshotting must not affect the copy —
      // this is exactly the TOCTOU window the snapshot exists to close.
      await writeFile(a, "content-a-CHANGED");
      expect((await readFile(paths[0], "utf-8"))).toBe("content-a");
    } finally {
      await cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotRefs with no refs is a no-op that returns an empty list", async () => {
  const { paths, cleanup } = await snapshotRefs([]);
  expect(paths).toEqual([]);
  await expect(cleanup()).resolves.toBeUndefined();
});

test("snapshotRefs cleanup removes the snapshot directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const a = path.join(dir, "a.jpg");
    await writeFile(a, "content-a");
    const { paths, cleanup } = await snapshotRefs([a]);
    const snapshotDir = path.dirname(paths[0]);
    await cleanup();
    await expect(readFile(paths[0])).rejects.toThrow();
    await expect(readFile(snapshotDir)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotRefs cleans up its own tmp dir if a copy fails partway through", async () => {
  const { readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const a = path.join(dir, "a.jpg");
    const missing = path.join(dir, "does-not-exist.jpg");
    await writeFile(a, "content-a");

    const leaksBefore = (await readdir(tmpdir())).filter((n) => n.startsWith("agy-imggen-refs-"));

    await expect(snapshotRefs([a, missing])).rejects.toThrow(/ENOENT|no such file/i);

    // The tmp dir snapshotRefs created internally (with `a` already copied
    // in before the second, missing ref made the copy loop throw) must not
    // survive — there is no cleanup callback for the caller to invoke,
    // since the function never got to return one on this path.
    const leaksAfter = (await readdir(tmpdir())).filter((n) => n.startsWith("agy-imggen-refs-"));
    expect(leaksAfter.length).toBe(leaksBefore.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: the round-3 TOCTOU fix (snapshot refs into a fresh mkdtemp dir
// per run before hashing) broke caching entirely for ref-bearing requests,
// because the snapshot path is a different random tmp path every single
// invocation and cacheKey used to hash the path alongside the content.
// Byte-identical refs at different (snapshot) paths must produce the same
// key, or every ref-backed call permanently misses the cache.
test("cacheKey ignores the ref path — identical content at different snapshot paths yields the same key", async () => {
  const srcDir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const original = path.join(srcDir, "character.jpg");
    await writeFile(original, "same bytes");

    const snap1 = await snapshotRefs([original]);
    const snap2 = await snapshotRefs([original]);
    try {
      expect(snap1.paths[0]).not.toBe(snap2.paths[0]); // different mkdtemp runs
      const k1 = await cacheKey("hello", "1:1", "gemini-3.7-flash-medium", snap1.paths);
      const k2 = await cacheKey("hello", "1:1", "gemini-3.7-flash-medium", snap2.paths);
      expect(k1).toBe(k2);
    } finally {
      await snap1.cleanup();
      await snap2.cleanup();
    }
  } finally {
    await rm(srcDir, { recursive: true, force: true });
  }
});

// --- resolveGenerationFromRun: recovering an ERROR-status run that actually
// succeeded (agy's own status field is unreliable — see spawn.ts) ---

const CONVERSATION_ID = "test-conv-id";
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

async function withFakeHome<T>(fn: (agyHomeDir: string) => Promise<T>): Promise<T> {
  const agyHomeDir = await mkdtemp(path.join(tmpdir(), "agy-fakehome-"));
  const orig = process.env._AGY_IMAGEGEN_TEST_HOME;
  process.env._AGY_IMAGEGEN_TEST_HOME = agyHomeDir;
  try {
    return await fn(agyHomeDir);
  } finally {
    if (orig === undefined) delete process.env._AGY_IMAGEGEN_TEST_HOME;
    else process.env._AGY_IMAGEGEN_TEST_HOME = orig;
    await rm(agyHomeDir, { recursive: true, force: true });
  }
}

async function writeTranscript(agyHomeDir: string, conversationId: string, content: string): Promise<void> {
  const dir = path.join(agyHomeDir, "brain", conversationId, ".system_generated", "logs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "transcript.jsonl"), content, "utf-8");
}

function transcriptWithSavedPath(savedPath: string): string {
  return [
    `{"step_index":0,"status":"DONE","type":"PLANNER_RESPONSE","tool_calls":[{"name":"generate_image","args":{}}]}`,
    `{"step_index":1,"status":"DONE","type":"GENERATE_IMAGE","content":"Generated image is saved at ${savedPath}."}`,
  ].join("\n");
}

// A transcript with no generate_image call at all — the "real refusal" case.
const TRANSCRIPT_NO_TOOL_CALL = `{"step_index":0,"status":"DONE","type":"PLANNER_RESPONSE","content":"I can't help with that."}`;

function fakeRun(overrides: Partial<AgyRunResult>): AgyRunResult {
  return {
    conversationId: CONVERSATION_ID,
    responseText: "OK",
    usage: null,
    rawLogPath: "/tmp/fake-log.json",
    durationMs: 100,
    status: "SUCCESS",
    rawError: null,
    ...overrides,
  };
}

test("resolveGenerationFromRun: ERROR status + transcript proves generate_image really ran → treated as success", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    const savedImage = path.join(brain, "out.jpg");
    await mkdir(brain, { recursive: true });
    await writeFile(savedImage, Buffer.concat([JPEG_HEADER, Buffer.alloc(5000)]));
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath(savedImage));

    const outDir = await mkdtemp(path.join(tmpdir(), "agy-out-"));
    try {
      const outputPath = path.join(outDir, "final.jpg");
      const logFile = path.join(outDir, "log.jsonl");
      const log = new JsonLogger(logFile, false);

      const run = fakeRun({
        status: "ERROR",
        rawError: "failed to generate content: 429 Too Many Requests, RESOURCE_EXHAUSTED",
      });

      const result = await resolveGenerationFromRun(run, outputPath, log);

      expect(result.bytes).toBeGreaterThan(1000);
      expect(result.conversationId).toBe(CONVERSATION_ID);
      const copied = await readFile(outputPath);
      expect(copied.subarray(0, 4).equals(JPEG_HEADER)).toBe(true);

      // The recovery must be logged distinctly (to measure how often agy's
      // status field is a false negative), with the real status/rawError.
      const logLines = (await readFile(logFile, "utf-8")).trim().split("\n").map((l) => JSON.parse(l));
      const recoveryLog = logLines.find((l) => l.event === "status_error_but_recovered");
      expect(recoveryLog).toBeDefined();
      expect(recoveryLog.status).toBe("ERROR");
      expect(recoveryLog.rawError).toContain("RESOURCE_EXHAUSTED");
      expect(recoveryLog.conversation_id).toBe(CONVERSATION_ID);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

test("resolveGenerationFromRun: ERROR status + no generate_image call in transcript → real failure, error message carries rawError", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_NO_TOOL_CALL);

    const outDir = await mkdtemp(path.join(tmpdir(), "agy-out-"));
    try {
      const outputPath = path.join(outDir, "final.jpg");
      const log = new JsonLogger(null, false);

      const rawError = "content policy violation: depicts a real person without consent";
      const run = fakeRun({ status: "ERROR", rawError });

      let caught: unknown;
      try {
        await resolveGenerationFromRun(run, outputPath, log);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(GenError);
      expect((caught as GenError).kind).toBe("agent_refused");
      expect((caught as GenError).message).toContain(rawError);
      await expect(readFile(outputPath)).rejects.toThrow();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

test("resolveGenerationFromRun: SUCCESS status behaves exactly as before (no regression) — valid generation copies through with no recovery log", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    const savedImage = path.join(brain, "out.jpg");
    await mkdir(brain, { recursive: true });
    await writeFile(savedImage, Buffer.concat([JPEG_HEADER, Buffer.alloc(5000)]));
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath(savedImage));

    const outDir = await mkdtemp(path.join(tmpdir(), "agy-out-"));
    try {
      const outputPath = path.join(outDir, "final.jpg");
      const logFile = path.join(outDir, "log.jsonl");
      const log = new JsonLogger(logFile, false);

      const run = fakeRun({ status: "SUCCESS", rawError: null });
      const result = await resolveGenerationFromRun(run, outputPath, log);

      expect(result.bytes).toBeGreaterThan(1000);
      // No status_error_but_recovered event should ever fire on the SUCCESS
      // path — resolveGenerationFromRun logs nothing here, so the log file
      // is never even created.
      await expect(readFile(logFile, "utf-8")).rejects.toThrow(/ENOENT/);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

test("resolveGenerationFromRun: SUCCESS status but verification fails → original verification error surfaces (not rewritten to agent_refused with rawError)", async () => {
  await withFakeHome(async (agyHomeDir) => {
    // No transcript written at all — verifyGeneration fails with
    // no_image_gen_tool_use, distinct from the agent_refused kind used for
    // a real ERROR-status refusal.
    const outDir = await mkdtemp(path.join(tmpdir(), "agy-out-"));
    try {
      const outputPath = path.join(outDir, "final.jpg");
      const log = new JsonLogger(null, false);
      const run = fakeRun({ status: "SUCCESS", rawError: null });

      let caught: unknown;
      try {
        await resolveGenerationFromRun(run, outputPath, log);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(GenError);
      expect((caught as GenError).kind).toBe("no_image_gen_tool_use");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});
