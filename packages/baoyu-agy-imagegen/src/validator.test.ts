import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, readFile, mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifySourceImage, copyOutputAtomic, verifyGeneration } from "./validator.ts";
import { GenError, RETRYABLE } from "./types.ts";

const CONVERSATION_ID = "test-conv-id";

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

function transcriptWithSavedPath(savedPath: string): string {
  return [
    `{"step_index":0,"status":"DONE","type":"PLANNER_RESPONSE","tool_calls":[{"name":"generate_image","args":{}}]}`,
    `{"step_index":1,"status":"DONE","type":"GENERATE_IMAGE","content":"Generated image is saved at ${savedPath}."}`,
  ].join("\n");
}

async function writeTranscript(agyHomeDir: string, conversationId: string, content: string): Promise<void> {
  const dir = path.join(agyHomeDir, "brain", conversationId, ".system_generated", "logs");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "transcript.jsonl"), content, "utf-8");
}

async function writeServerLog(
  agyHomeDir: string,
  name: string,
  content: string,
  ageMs = 0,
): Promise<void> {
  const dir = path.join(agyHomeDir, "log");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, content, "utf-8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
}

// Current-format transcript: generate_image ran (tool_call in PLANNER_RESPONSE)
// but there is no "saved at <path>" text anywhere — the wrapper must recover
// the output by scanning the run's brain dir.
const TRANSCRIPT_TOOL_CALL_NO_PATH =
  '{"step_index":0,"status":"DONE","type":"PLANNER_RESPONSE","tool_calls":[{"name":"generate_image","args":{}}]}';

// The geo gate aborts before generate_image is even attempted: USER_INPUT +
// a contentless PLANNER_RESPONSE, nothing else.
const TRANSCRIPT_GEO_GATE_ABORT = [
  '{"step_index":0,"status":"DONE","type":"USER_INPUT","content":"draw a cat"}',
  '{"step_index":1,"status":"DONE","type":"PLANNER_RESPONSE"}',
].join("\n");

const SERVER_LOG_GEO = [
  "ERROR: logging before google.Init: I0904 conversation_manager.go:764] Streaming conversation test-conv-id",
  "ERROR: logging before google.Init: E0904 errorreport.go:224] agent executor error: calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use.",
  "ERROR: logging before google.Init: E0904 session.go:226] Print mode: run ended with error and no response: Agent execution terminated due to error.",
].join("\n");

const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("verifySourceImage accepts a valid JPEG", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-val-"));
  try {
    const p = path.join(dir, "good.jpg");
    await writeFile(p, Buffer.concat([JPEG_HEADER, Buffer.alloc(5000)]));
    const r = await verifySourceImage(p);
    expect(r.bytes).toBeGreaterThan(1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifySourceImage also accepts a valid PNG", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-val-"));
  try {
    const p = path.join(dir, "good.png");
    await writeFile(p, Buffer.concat([PNG_HEADER, Buffer.alloc(5000)]));
    const r = await verifySourceImage(p);
    expect(r.bytes).toBeGreaterThan(1000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifySourceImage rejects missing file", async () => {
  await expect(verifySourceImage("/no/such/file.jpg")).rejects.toBeInstanceOf(GenError);
});

test("verifySourceImage rejects tiny file", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-val-"));
  try {
    const p = path.join(dir, "tiny.jpg");
    await writeFile(p, "tiny");
    await expect(verifySourceImage(p)).rejects.toThrow(/too small/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifySourceImage rejects non-image magic", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-val-"));
  try {
    const p = path.join(dir, "fake.jpg");
    await writeFile(p, Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(5000)]));
    await expect(verifySourceImage(p)).rejects.toThrow(/neither JPEG nor PNG/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("verifyGeneration accepts a saved path inside this run's brain dir", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath(path.join(brain, "out.jpg")));
    const result = await verifyGeneration(CONVERSATION_ID, Date.now() - 60_000);
    expect(result.sourcePath).toBe(path.join(brain, "out.jpg"));
  });
});

test("verifyGeneration rejects a transcript-reported path outside this run's brain dir", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath("/etc/passwd.jpg"));
    await expect(verifyGeneration(CONVERSATION_ID, Date.now() - 60_000)).rejects.toThrow(/escapes this run's brain dir/);
  });
});

test("verifyGeneration rejects a `..` traversal out of the brain dir", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    const escaping = path.join(brain, "..", "..", "sibling-conv", "out.jpg");
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath(escaping));
    await expect(verifyGeneration(CONVERSATION_ID, Date.now() - 60_000)).rejects.toThrow(/escapes this run's brain dir/);
  });
});

// --- current-format brain-dir scan (no "saved at" text in transcript) ---

test("verifyGeneration recovers the output by scanning the run's brain dir when the transcript has no saved path", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    await mkdir(brain, { recursive: true });
    const img = path.join(brain, "agy_imagegen_output_1787000000000.jpg");
    await writeFile(img, Buffer.concat([JPEG_HEADER, Buffer.alloc(3000)]));
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_TOOL_CALL_NO_PATH);

    const result = await verifyGeneration(CONVERSATION_ID, Date.now() - 60_000);
    expect(result.sourcePath).toBe(img);
  });
});

test("verifyGeneration picks the newest brain-dir output when several exist", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    await mkdir(brain, { recursive: true });
    const older = path.join(brain, "agy_imagegen_output_1.jpg");
    const newer = path.join(brain, "agy_imagegen_output_2.jpg");
    await writeFile(older, Buffer.concat([JPEG_HEADER, Buffer.alloc(3000)]));
    await writeFile(newer, Buffer.concat([JPEG_HEADER, Buffer.alloc(3000)]));
    await utimes(older, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_TOOL_CALL_NO_PATH);

    const result = await verifyGeneration(CONVERSATION_ID, Date.now() - 60_000);
    expect(result.sourcePath).toBe(newer);
  });
});

test("verifyGeneration: tool ran, no output file, no quota/geo signal → no_image_gen_tool_use", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_TOOL_CALL_NO_PATH);
    await expect(verifyGeneration(CONVERSATION_ID, Date.now() - 60_000)).rejects.toThrow(/no output file was found/);
  });
});

test("verifyGeneration: tool ran, no output file, 429 text in transcript → quota_exhausted", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const transcript = [
      TRANSCRIPT_TOOL_CALL_NO_PATH,
      '{"step_index":1,"status":"DONE","type":"ERROR_MESSAGE","content":"generate_image failed: RESOURCE_EXHAUSTED (429)"}',
    ].join("\n");
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcript);
    let caught: unknown;
    try {
      await verifyGeneration(CONVERSATION_ID, Date.now() - 60_000);
    } catch (e) {
      caught = e;
    }
    expect((caught as GenError).kind).toBe("quota_exhausted");
  });
});

test("verifyGeneration refuses an unsafe conversationId without touching the filesystem", async () => {
  await withFakeHome(async () => {
    let caught: unknown;
    try {
      await verifyGeneration("../../etc", Date.now());
    } catch (e) {
      caught = e;
    }
    expect((caught as GenError).kind).toBe("agent_refused");
    expect((caught as GenError).message).toMatch(/unsafe conversation_id/);
    // An unsafe id never becomes safe on retry — must be a hard failure even
    // though "agent_refused" is otherwise in RETRYABLE.
    expect((caught as GenError).retryable).toBe(false);
    expect(RETRYABLE.has("agent_refused")).toBe(true);
  });
});

// --- Google's geo/ASN gate (location_not_supported) ---

test("location_not_supported is NOT in the RETRYABLE set", () => {
  expect(RETRYABLE.has("location_not_supported")).toBe(false);
});

test("verifyGeneration: empty transcript + geo line in this run's server log → location_not_supported", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_GEO_GATE_ABORT);
    await writeServerLog(agyHomeDir, "cli-20260904_093533.log", SERVER_LOG_GEO);

    let caught: unknown;
    try {
      await verifyGeneration(CONVERSATION_ID, Date.now() - 60_000);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GenError);
    expect((caught as GenError).kind).toBe("location_not_supported");
    expect((caught as GenError).retryable).toBe(false);
    expect((caught as GenError).message).toMatch(/User location is not supported/);
  });
});

test("verifyGeneration: geo phrase only in agy's transcript diagnostic channel is enough (no server log needed)", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const transcript = [
      '{"step_index":0,"status":"DONE","type":"USER_INPUT","content":"draw a cat"}',
      '{"step_index":1,"status":"DONE","type":"PLANNER_RESPONSE","content":"calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use."}',
    ].join("\n");
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcript);

    let caught: unknown;
    try {
      await verifyGeneration(CONVERSATION_ID, Date.now() - 60_000);
    } catch (e) {
      caught = e;
    }
    expect((caught as GenError).kind).toBe("location_not_supported");
  });
});

test("verifyGeneration: a stale (>15 min old) server log with the geo line is ignored → falls back to no_image_gen_tool_use", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_GEO_GATE_ABORT);
    await writeServerLog(agyHomeDir, "cli-old.log", SERVER_LOG_GEO, 30 * 60 * 1000);

    await expect(verifyGeneration(CONVERSATION_ID, Date.now() - 60_000)).rejects.toThrow(/generate_image was not invoked/);
  });
});

test("verifyGeneration: a recent server log that does NOT mention this conversation id is not used", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_GEO_GATE_ABORT);
    await writeServerLog(
      agyHomeDir,
      "cli-other.log",
      SERVER_LOG_GEO.replace(/test-conv-id/g, "some-other-conversation"),
    );
    await expect(verifyGeneration(CONVERSATION_ID, Date.now() - 60_000)).rejects.toThrow(/generate_image was not invoked/);
  });
});

// Codex adversarial-review regression: with many concurrent unrelated agy
// runs writing logs, the geo gate for THIS run must still be detected —
// the run-start bound + id correlation, not a global newest-N cap.
test("verifyGeneration: geo gate still surfaces behind 20 newer unrelated server logs (run-start bound)", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, TRANSCRIPT_GEO_GATE_ABORT);
    // A few seconds of slack so a coarse-granularity mtime can't round the
    // freshly-written logs to just before the bound.
    const runStartedAtMs = Date.now() - 5_000;
    await writeServerLog(agyHomeDir, "cli-ours.log", SERVER_LOG_GEO);
    for (let i = 0; i < 20; i++) {
      await writeServerLog(
        agyHomeDir,
        `cli-concurrent-${i}.log`,
        SERVER_LOG_GEO.replace(/test-conv-id/g, `concurrent-run-${i}`),
      );
    }
    let caught: unknown;
    try {
      await verifyGeneration(CONVERSATION_ID, runStartedAtMs);
    } catch (e) {
      caught = e;
    }
    expect((caught as GenError).kind).toBe("location_not_supported");
  });
});

test("copyOutputAtomic copies bytes and leaves no temp file behind", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-val-"));
  try {
    const src = path.join(dir, "src.jpg");
    const dst = path.join(dir, "nested", "out.jpg");
    await writeFile(src, Buffer.concat([JPEG_HEADER, Buffer.alloc(2000)]));
    const bytes = await copyOutputAtomic(src, dst);
    expect(bytes).toBe(2004);
    const copied = await readFile(dst);
    const original = await readFile(src);
    expect(copied.equals(original)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
