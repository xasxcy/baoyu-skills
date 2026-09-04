import { stat, rename, mkdir, copyFile, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import { GenError } from "./types.ts";
import {
  extractSavedImagePath,
  hasGenerateImageInvocation,
  detectQuotaError,
  detectLocationError,
  detectLocationErrorInSteps,
  type TranscriptStep,
} from "./parser.ts";
import { readTranscript, brainDir, readServerLogForConversation } from "./spawn.ts";

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// main.ts's buildInstruction() hard-codes generate_image's ImageName to
// `agy_imagegen_output`; agy writes the result as
// `<ImageName>_<epochMillis>.<ext>` in the run's brain dir. Keep this in
// sync with buildInstruction() if that constant ever changes.
const AGY_OUTPUT_BASENAME_RE = /^agy_imagegen_output.*\.(?:jpe?g|png)$/i;

// `conversationId` is read from agy's stdout JSON — untrusted. Every
// filesystem path this module builds from it (brainDir, readTranscript,
// scanBrainForOutput) joins it as a single directory name under the
// antigravity home, so it must be exactly one safe path component. The
// real value is a UUID; this also rejects "/", "..", ".", and empty.
const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeConversationId(conversationId: string): void {
  if (!SAFE_CONVERSATION_ID_RE.test(conversationId) || conversationId === "." || conversationId === "..") {
    // Force retryable:false — "agent_refused" is in RETRYABLE, but an unsafe
    // id never becomes safe on a retry, so retrying only burns agy cold starts.
    throw new GenError(
      "agent_refused",
      `agy produced an unsafe conversation_id: ${conversationId}`,
      false,
    );
  }
}

// The current agy transcript format records the saved path nowhere (no
// GENERATE_IMAGE step, no "saved at <path>" text). Recover the output by
// scanning THIS run's own brain dir — trustworthy because each run gets a
// fresh conversation dir (see runAgyExec's "never pass --continue" note).
// Non-recursive by nature: readdir + isFile() skips the `.system_generated`
// / `.user_uploaded` / `scratch` subdirs. Returns the newest matching file
// (by mtime) plus the full dir listing for diagnostics on a miss.
async function scanBrainForOutput(
  conversationId: string,
): Promise<{ match: string | null; entries: string[] }> {
  const brain = brainDir(conversationId);
  let dirents;
  try {
    dirents = await readdir(brain, { withFileTypes: true });
  } catch {
    return { match: null, entries: [] };
  }
  const entries = dirents.map((d) => d.name).sort();
  let newest: { path: string; mtimeMs: number } | null = null;
  for (const d of dirents) {
    if (!d.isFile() || !AGY_OUTPUT_BASENAME_RE.test(d.name)) continue;
    const filePath = path.join(brain, d.name);
    const s = await stat(filePath);
    if (!newest || s.mtimeMs > newest.mtimeMs) {
      newest = { path: filePath, mtimeMs: s.mtimeMs };
    }
  }
  return { match: newest?.path ?? null, entries };
}

export interface VerifiedGeneration {
  steps: TranscriptStep[];
  sourcePath: string;
}

// Google's geo/ASN gate on the model call leaves an empty transcript (just
// USER_INPUT + a contentless PLANNER_RESPONSE) and a generic stdout error,
// so it would otherwise be misread as a retryable no_image_gen_tool_use.
// Check agy's own diagnostic channels — transcript steps first (fs-free,
// forward hedge), then the per-invocation server log where the real
// `FAILED_PRECONDITION ... User location is not supported` line actually
// lands. Returns the matched line, or null.
async function detectLocationGate(
  conversationId: string,
  steps: TranscriptStep[],
  runStartedAtMs: number,
): Promise<string | null> {
  const fromSteps = detectLocationErrorInSteps(steps);
  if (fromSteps) return fromSteps;
  const serverLog = await readServerLogForConversation(conversationId, runStartedAtMs);
  return serverLog ? detectLocationError(serverLog) : null;
}

// Real evidence that generate_image ran in THIS run: a GENERATE_IMAGE step
// (or a generate_image tool_call) in this conversation's transcript, plus
// the file it says it saved actually existing on disk. Trusting the
// top-level JSON response text alone is not enough — the model could
// describe success without having called the tool.
export async function verifyGeneration(
  conversationId: string | null,
  runStartedAtMs: number,
): Promise<VerifiedGeneration> {
  if (!conversationId) {
    throw new GenError("agent_refused", "agy produced no conversation_id");
  }
  // Validate before any readTranscript / brainDir / scanBrainForOutput call
  // so an unsafe id is refused without touching the filesystem.
  assertSafeConversationId(conversationId);
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
    const geoMsg = await detectLocationGate(conversationId, steps, runStartedAtMs);
    if (geoMsg) {
      throw new GenError("location_not_supported", geoMsg);
    }
    throw new GenError("no_image_gen_tool_use", `generate_image was not invoked in ${conversationId}`);
  }

  // Old agy wrote a GENERATE_IMAGE step containing "saved at <path>". Try
  // that first for backward compatibility with older installs; the path is
  // text from the model's own transcript content — not structurally trusted
  // — so resolve it against this run's brain dir and refuse anything that
  // resolves outside it (absolute paths elsewhere, `..` traversal, etc.).
  const rawPath = extractSavedImagePath(steps);
  if (rawPath) {
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

  // Current agy: no saved-path text anywhere in the transcript. Find the
  // generate_image output file directly in this run's brain dir. The
  // returned path is brainDir(...) + a readdir entry name, so it is inside
  // the brain-dir security boundary by construction — no escape check needed.
  const { match, entries } = await scanBrainForOutput(conversationId);
  if (match) {
    return { steps, sourcePath: match };
  }

  // generate_image was invoked but produced no output file. A genuine
  // quota / 429 exhaustion looks exactly like this at the file level but
  // leaves a diagnostic in a transcript step — surface it as a distinct,
  // retryable-with-backoff error rather than a generic no_image_gen_tool_use.
  const quotaMsg = detectQuotaError(steps);
  if (quotaMsg) {
    throw new GenError("quota_exhausted", quotaMsg);
  }

  // Rare on this path (the gate usually aborts before generate_image is
  // even attempted), but a mid-run gate flip would land here — keep the
  // non-retryable classification rather than falling through to a retry.
  const geoMsg = await detectLocationGate(conversationId, steps, runStartedAtMs);
  if (geoMsg) {
    throw new GenError("location_not_supported", geoMsg);
  }

  throw new GenError(
    "no_image_gen_tool_use",
    `generate_image ran but no output file was found in the brain dir for ${conversationId}` +
      (entries.length
        ? ` (brain dir contains: ${entries.join(", ")})`
        : " (brain dir empty or unreadable)"),
  );
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
  // PNG magic is the longest at 8 bytes; read exactly that so `head` can be
  // compared to PNG_MAGIC directly (JPEG only needs the first 3).
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
