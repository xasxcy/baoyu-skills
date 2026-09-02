import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { verifyGeneration, verifySourceImage } from "./validator.ts";
import { resolveGenerationFromRun } from "./main.ts";
import { JsonLogger } from "./logger.ts";
import type { AgyRunResult } from "./types.ts";

const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2048, 0)]);
const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2048, 0),
]);

const NEW_FORMAT_TRANSCRIPT = [
  JSON.stringify({
    step_index: 0,
    source: "planner",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [{ name: "generate_image", args: { AspectRatio: '"1:1"', ImageName: '"agy_imagegen_output"' } }],
  }),
  JSON.stringify({
    step_index: 1,
    source: "tool",
    type: "GENERIC",
    status: "DONE",
    content: "Created At: 2026-09-02T10:00:00Z\nCompleted At: 2026-09-02T10:00:20Z\nUsing prompt: a red bicycle",
  }),
  JSON.stringify({ step_index: 2, source: "planner", type: "PLANNER_RESPONSE", status: "DONE", content: "OK" }),
].join("\n");

const QUOTA_TRANSCRIPT = [
  JSON.stringify({
    step_index: 0,
    source: "planner",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [{ name: "generate_image", args: {} }],
  }),
  JSON.stringify({
    step_index: 1,
    source: "planner",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    content:
      "调用 generate_image 生成图片失败：当前模型的配额已耗尽（429 Resource Exhausted / QUOTA_EXHAUSTED），请稍后重试。",
  }),
].join("\n");

// The only "429" / "RESOURCE_EXHAUSTED" text is the user's own prompt echoed
// back in the GENERIC step's "Using prompt:" line — not an upstream rate
// limit. detectQuotaError must ignore it (GENERIC is not a scanned type, and
// the "Using prompt:" truncation is a second guard).
const PROMPT_ECHO_429_TRANSCRIPT = [
  JSON.stringify({
    step_index: 0,
    source: "planner",
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [{ name: "generate_image", args: {} }],
  }),
  JSON.stringify({
    step_index: 1,
    source: "tool",
    type: "GENERIC",
    status: "DONE",
    content:
      "Created At: 2026-09-02T10:00:00Z\nCompleted At: 2026-09-02T10:00:20Z\nUsing prompt: a poster about HTTP 429 and RESOURCE_EXHAUSTED errors",
  }),
  JSON.stringify({ step_index: 2, source: "planner", type: "PLANNER_RESPONSE", status: "DONE", content: "OK" }),
].join("\n");

let brainCounter = 0;

// Builds a fixture antigravity home with one conversation's brain dir +
// transcript, points _AGY_IMAGEGEN_TEST_HOME at it, and hands back a cleanup
// that also restores the previous env value.
async function makeFixture(transcript: string): Promise<{
  conversationId: string;
  brain: string;
  cleanup: () => Promise<void>;
}> {
  const home = await mkdtemp(path.join(tmpdir(), "agy-validator-test-"));
  const conversationId = `conv-${process.pid}-${brainCounter++}`;
  const brain = path.join(home, "brain", conversationId);
  await mkdir(path.join(brain, ".system_generated", "logs"), { recursive: true });
  await writeFile(path.join(brain, ".system_generated", "logs", "transcript.jsonl"), transcript);
  const prev = process.env._AGY_IMAGEGEN_TEST_HOME;
  process.env._AGY_IMAGEGEN_TEST_HOME = home;
  return {
    conversationId,
    brain,
    cleanup: async () => {
      if (prev === undefined) delete process.env._AGY_IMAGEGEN_TEST_HOME;
      else process.env._AGY_IMAGEGEN_TEST_HOME = prev;
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("verifyGeneration: new-format transcript + brain-dir output file -> returns that file path", async () => {
  const fx = await makeFixture(NEW_FORMAT_TRANSCRIPT);
  try {
    const out = path.join(fx.brain, "agy_imagegen_output_1788000000000.jpg");
    await writeFile(out, JPEG_BYTES);
    const { sourcePath } = await verifyGeneration(fx.conversationId);
    assert.equal(sourcePath, out);
    const { bytes } = await verifySourceImage(sourcePath);
    assert.equal(bytes, JPEG_BYTES.length);
  } finally {
    await fx.cleanup();
  }
});

test("verifyGeneration: multiple output files -> newest by mtime wins", async () => {
  const fx = await makeFixture(NEW_FORMAT_TRANSCRIPT);
  try {
    const older = path.join(fx.brain, "agy_imagegen_output_1788000000000.jpg");
    const newer = path.join(fx.brain, "agy_imagegen_output_1788000999999.jpg");
    await writeFile(older, JPEG_BYTES);
    await writeFile(newer, JPEG_BYTES);
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    await utimes(newer, new Date(2_000_000), new Date(2_000_000));
    const { sourcePath } = await verifyGeneration(fx.conversationId);
    assert.equal(sourcePath, newer);
  } finally {
    await fx.cleanup();
  }
});

test("verifyGeneration: new-format transcript + NO output file + no quota text -> no_image_gen_tool_use", async () => {
  const fx = await makeFixture(NEW_FORMAT_TRANSCRIPT);
  try {
    await assert.rejects(verifyGeneration(fx.conversationId), (e: any) => {
      assert.equal(e.kind, "no_image_gen_tool_use");
      return true;
    });
  } finally {
    await fx.cleanup();
  }
});

test("verifyGeneration: NO output file + 429/QUOTA_EXHAUSTED text in transcript -> quota_exhausted", async () => {
  const fx = await makeFixture(QUOTA_TRANSCRIPT);
  try {
    await assert.rejects(verifyGeneration(fx.conversationId), (e: any) => {
      assert.equal(e.kind, "quota_exhausted");
      assert.equal(e.retryable, true);
      assert.match(e.message, /QUOTA_EXHAUSTED/);
      return true;
    });
  } finally {
    await fx.cleanup();
  }
});

test("verifyGeneration: old-format 'saved at' transcript pointing inside brain dir still works (fallback)", async () => {
  // Build the transcript AFTER we know the brain path so the embedded
  // absolute path resolves inside it.
  const fx = await makeFixture("");
  try {
    const out = path.join(fx.brain, "agy_imagegen_output.png");
    const transcript = [
      JSON.stringify({
        step_index: 0,
        source: "planner",
        type: "PLANNER_RESPONSE",
        status: "DONE",
        tool_calls: [{ name: "generate_image", args: {} }],
      }),
      JSON.stringify({
        step_index: 1,
        source: "tool",
        type: "GENERATE_IMAGE",
        status: "DONE",
        content: `Image saved at "${out}".`,
      }),
    ].join("\n");
    await writeFile(path.join(fx.brain, ".system_generated", "logs", "transcript.jsonl"), transcript);
    await writeFile(out, PNG_BYTES);
    const { sourcePath } = await verifyGeneration(fx.conversationId);
    assert.equal(sourcePath, out);
  } finally {
    await fx.cleanup();
  }
});

test("verifySourceImage: PNG output is accepted (regression: PNG magic is the full 8-byte read)", async () => {
  const fx = await makeFixture(NEW_FORMAT_TRANSCRIPT);
  try {
    const out = path.join(fx.brain, "agy_imagegen_output_1788000000001.png");
    await writeFile(out, PNG_BYTES);
    const { sourcePath } = await verifyGeneration(fx.conversationId);
    const { bytes } = await verifySourceImage(sourcePath);
    assert.equal(bytes, PNG_BYTES.length);
  } finally {
    await fx.cleanup();
  }
});

test("verifySourceImage: a non-image blob is rejected as invalid_jpeg", async () => {
  const fx = await makeFixture(NEW_FORMAT_TRANSCRIPT);
  try {
    const out = path.join(fx.brain, "agy_imagegen_output_1788000000003.jpg");
    await writeFile(out, Buffer.alloc(4096, 0x41)); // "AAAA..."
    const { sourcePath } = await verifyGeneration(fx.conversationId);
    await assert.rejects(verifySourceImage(sourcePath), (e: any) => {
      assert.equal(e.kind, "invalid_jpeg");
      return true;
    });
  } finally {
    await fx.cleanup();
  }
});

test("verifyGeneration: an unsafe conversationId is refused as agent_refused without touching the filesystem", async () => {
  // Point the antigravity home at a dir that does not exist, so if the guard
  // regressed and the code fell through to a readdir/readFile, the failure
  // kind would be no_image_gen_tool_use (ENOENT), not agent_refused.
  const prev = process.env._AGY_IMAGEGEN_TEST_HOME;
  process.env._AGY_IMAGEGEN_TEST_HOME = path.join(tmpdir(), `agy-nonexistent-${process.pid}`);
  try {
    for (const bad of ["../../etc", "a/b", ".."]) {
      await assert.rejects(verifyGeneration(bad), (e: any) => {
        assert.equal(e.kind, "agent_refused");
        assert.match(e.message, /unsafe conversation_id/);
        return true;
      });
    }
  } finally {
    if (prev === undefined) delete process.env._AGY_IMAGEGEN_TEST_HOME;
    else process.env._AGY_IMAGEGEN_TEST_HOME = prev;
  }
});

test("verifyGeneration: a '429' only in the echoed prompt (GENERIC step) + no output file -> no_image_gen_tool_use, not quota_exhausted", async () => {
  const fx = await makeFixture(PROMPT_ECHO_429_TRANSCRIPT);
  try {
    await assert.rejects(verifyGeneration(fx.conversationId), (e: any) => {
      assert.equal(e.kind, "no_image_gen_tool_use");
      return true;
    });
  } finally {
    await fx.cleanup();
  }
});

test("resolveGenerationFromRun: quota_exhausted survives even when agy status is non-SUCCESS", async () => {
  const fx = await makeFixture(QUOTA_TRANSCRIPT);
  try {
    const run: AgyRunResult = {
      conversationId: fx.conversationId,
      responseText: "OK",
      usage: null,
      rawLogPath: "/tmp/does-not-matter.json",
      durationMs: 1234,
      status: "ERROR",
      rawError: "agy reported status=ERROR: internal",
    };
    const log = new JsonLogger(null, false);
    await assert.rejects(
      resolveGenerationFromRun(run, path.join(fx.brain, "final.jpg"), log),
      (e: any) => {
        assert.equal(e.kind, "quota_exhausted");
        return true;
      },
    );
  } finally {
    await fx.cleanup();
  }
});
