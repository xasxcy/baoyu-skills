import { test, expect } from "bun:test";
import { mkdtemp, writeFile, rm, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifySourceImage, copyOutputAtomic, verifyGeneration } from "./validator.ts";
import { GenError } from "./types.ts";

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
    const result = await verifyGeneration(CONVERSATION_ID);
    expect(result.sourcePath).toBe(path.join(brain, "out.jpg"));
  });
});

test("verifyGeneration rejects a transcript-reported path outside this run's brain dir", async () => {
  await withFakeHome(async (agyHomeDir) => {
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath("/etc/passwd.jpg"));
    await expect(verifyGeneration(CONVERSATION_ID)).rejects.toThrow(/escapes this run's brain dir/);
  });
});

test("verifyGeneration rejects a `..` traversal out of the brain dir", async () => {
  await withFakeHome(async (agyHomeDir) => {
    const brain = path.join(agyHomeDir, "brain", CONVERSATION_ID);
    const escaping = path.join(brain, "..", "..", "sibling-conv", "out.jpg");
    await writeTranscript(agyHomeDir, CONVERSATION_ID, transcriptWithSavedPath(escaping));
    await expect(verifyGeneration(CONVERSATION_ID)).rejects.toThrow(/escapes this run's brain dir/);
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
