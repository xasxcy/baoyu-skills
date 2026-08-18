import { stat, rename, mkdir, copyFile, unlink } from "node:fs/promises";
import path from "node:path";
import { GenError } from "./types.ts";
import {
  extractSavedImagePath,
  hasGenerateImageInvocation,
  type TranscriptStep,
} from "./parser.ts";
import { readTranscript, brainDir } from "./spawn.ts";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface VerifiedGeneration {
  steps: TranscriptStep[];
  sourcePath: string;
}

// Real evidence that generate_image ran in THIS run: a GENERATE_IMAGE step
// (or a generate_image tool_call) in this conversation's transcript, plus
// the file it says it saved actually existing on disk. Trusting the
// top-level JSON response text alone is not enough — the model could
// describe success without having called the tool.
export async function verifyGeneration(conversationId: string | null): Promise<VerifiedGeneration> {
  if (!conversationId) {
    throw new GenError("agent_refused", "agy produced no conversation_id");
  }
  let steps: TranscriptStep[];
  try {
    steps = await readTranscript(conversationId);
  } catch (e: any) {
    throw new GenError(
      "no_image_gen_tool_use",
      `Could not read transcript for ${conversationId}: ${e?.code ?? e?.message}`,
    );
  }
  if (!hasGenerateImageInvocation(steps)) {
    throw new GenError("no_image_gen_tool_use", `generate_image was not invoked in ${conversationId}`);
  }
  const rawPath = extractSavedImagePath(steps);
  if (!rawPath) {
    throw new GenError(
      "no_image_gen_tool_use",
      `generate_image ran but no saved-file path was found in the transcript for ${conversationId}`,
    );
  }
  // The path is text extracted from the model's own transcript content — not
  // structurally trusted. Resolve it against this run's brain dir and refuse
  // anything that resolves outside it (absolute paths elsewhere, `..`
  // traversal, etc.) rather than copying whatever file it names. This is
  // what actually makes "fresh conversation per run" a security boundary,
  // not just an organizational convention.
  const brain = brainDir(conversationId);
  const sourcePath = path.resolve(brain, rawPath);
  if (sourcePath !== brain && !sourcePath.startsWith(brain + path.sep)) {
    throw new GenError(
      "no_image_gen_tool_use",
      `Transcript-reported saved path escapes this run's brain dir: ${rawPath}`,
    );
  }
  return { steps, sourcePath };
}

async function readMagic(filePath: string, len: number): Promise<Buffer> {
  const { open } = await import("node:fs/promises");
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

export async function verifySourceImage(sourcePath: string): Promise<{ bytes: number }> {
  let s;
  try {
    s = await stat(sourcePath);
  } catch {
    throw new GenError("output_missing", `Generated file not found: ${sourcePath}`);
  }
  if (s.size < 1000) {
    throw new GenError("invalid_jpeg", `Generated file too small (${s.size} bytes): ${sourcePath}`);
  }
  const head = await readMagic(sourcePath, 8);
  const isJpeg = head.subarray(0, 3).equals(JPEG_MAGIC);
  const isPng = head.equals(PNG_MAGIC);
  if (!isJpeg && !isPng) {
    throw new GenError("invalid_jpeg", `Generated file is neither JPEG nor PNG (magic mismatch): ${sourcePath}`);
  }
  return { bytes: s.size };
}

function tempPathFor(outputPath: string): string {
  return `${outputPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

// Copy to a sibling temp file then rename, so a reader watching the
// destination never observes a partially written file. Mirrors
// baoyu-codex-imagegen's atomic-write convention.
export async function copyOutputAtomic(sourcePath: string, outputPath: string): Promise<number> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const tempPath = tempPathFor(outputPath);
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, outputPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  const s = await stat(outputPath);
  return s.size;
}
