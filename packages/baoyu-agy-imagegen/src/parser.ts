import type { TokenUsage } from "./types.ts";

// agy's --output-format json emits control characters (e.g. a bare newline
// inside the "response" string) unescaped, which is invalid per the JSON
// spec and rejected by both V8's and Python's strict parsers. Escaping any
// raw control byte before parsing fixes it without needing agy to change.
//
// Only escapes control bytes found *inside* a string literal — a naive
// blanket escape would also rewrite the structural whitespace between
// tokens (e.g. a pretty-printed `{\n  "a": 1\n}`), turning valid JSON
// into a stray-backslash parse error outside any string.
function sanitizeControlChars(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const c of raw) {
    const code = c.charCodeAt(0);
    if (inString && !escaped && code < 32) {
      if (c === "\n") out += "\\n";
      else if (c === "\r") out += "\\r";
      else if (c === "\t") out += "\\t";
      else out += "\\u" + code.toString(16).padStart(4, "0");
      continue;
    }
    out += c;
    if (escaped) {
      escaped = false;
    } else if (c === "\\" && inString) {
      escaped = true;
    } else if (c === '"') {
      inString = !inString;
    }
  }
  return out;
}

export interface AgyStdoutJson {
  conversation_id?: string;
  status?: string;
  response?: string;
  // Populated by agy on failure (e.g. an upstream 429 RESOURCE_EXHAUSTED
  // from cloudcode-pa.googleapis.com) with the real diagnostic text.
  // `response` is frequently empty or a meaningless placeholder like "OK"
  // on these paths, so `error` is what actually explains a non-SUCCESS
  // status.
  error?: string;
  duration_seconds?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

export function parseAgyStdout(raw: string): AgyStdoutJson {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("empty stdout");
  try {
    return JSON.parse(trimmed);
  } catch {
    return JSON.parse(sanitizeControlChars(trimmed));
  }
}

export function toTokenUsage(u: AgyStdoutJson["usage"]): TokenUsage | null {
  if (!u) return null;
  return {
    input: u.input_tokens ?? 0,
    cached_input: u.cache_read_tokens ?? 0,
    output: u.output_tokens ?? 0,
    thinking: u.thinking_tokens ?? 0,
  };
}

export interface TranscriptStep {
  step_index: number;
  source: string;
  type: string;
  status: string;
  content?: string;
  tool_calls?: { name: string; args: Record<string, string> }[];
}

export function parseTranscript(raw: string): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      steps.push(JSON.parse(line));
    } catch {
      // skip malformed lines rather than failing the whole transcript
    }
  }
  return steps;
}

// tool_calls[].args values are JSON-encoded strings (e.g. the AspectRatio
// value is literally the 4-character string `"1:1"`, quotes included), not
// raw values. Unwrap them with a nested JSON.parse.
export function unwrapToolCallArg(value: string | undefined): string | null {
  if (value == null) return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return value;
  }
}

export function hasGenerateImageInvocation(steps: TranscriptStep[]): boolean {
  return steps.some(
    (s) =>
      s.status === "DONE" &&
      (s.type === "GENERATE_IMAGE" ||
        (s.tool_calls ?? []).some((tc) => tc.name === "generate_image")),
  );
}

// Matches a quoted path (may contain spaces) or a bare \S+ path, in either
// case requiring a jpg/jpeg/png extension. The trailing sentence period seen
// in real transcripts is optional (not required) so a rephrase that ends the
// sentence differently — or a path followed directly by whitespace/EOL —
// still matches, rather than silently falling through to a full retry.
const SAVED_AT_RE = /saved at (?:"([^"\n]+\.(?:jpe?g|png))"|(\S+\.(?:jpe?g|png)))/i;

export function extractSavedImagePath(steps: TranscriptStep[]): string | null {
  for (const s of steps) {
    if (s.type !== "GENERATE_IMAGE" || !s.content) continue;
    const m = SAVED_AT_RE.exec(s.content);
    if (m) return (m[1] ?? m[2]).replace(/\.$/, "");
  }
  return null;
}

// A genuine quota / 429 RESOURCE_EXHAUSTED from agy's upstream image backend
// no longer reliably lands in the top-level stdout `status`/`error` fields —
// agy now writes the diagnostic into a transcript step's `content` (observed
// in the PLANNER_RESPONSE step that reports the tool failure, e.g.
// "...当前模型的配额已耗尽（429 Resource Exhausted / QUOTA_EXHAUSTED）...").
// Without this, that case degrades to a generic `no_image_gen_tool_use` and
// the caller can't tell "back off / rotate key" from "prompt refined".
const QUOTA_ERROR_RE = /RESOURCE_EXHAUSTED|QUOTA_EXHAUSTED|\b429\b|Resource Exhausted/i;

// Only scan steps that carry agy's own diagnostics. A GENERIC step echoes the
// caller's prompt back as "Using prompt: <text>" (buildInstruction embeds it),
// so a prompt that merely mentions "429" there must not read as a rate limit;
// USER_INPUT is the raw prompt for the same reason. PLANNER_RESPONSE is where
// the observed quota failure lands; ERROR_MESSAGE is agy's dedicated error
// channel (both are among the step types seen across real transcripts).
const QUOTA_SCAN_TYPES = new Set(["PLANNER_RESPONSE", "ERROR_MESSAGE"]);

export function detectQuotaError(steps: TranscriptStep[]): string | null {
  for (const s of steps) {
    if (!s.content || !QUOTA_SCAN_TYPES.has(s.type)) continue;
    // Belt and suspenders: even in a scanned step, cut anything after a
    // "Using prompt:" marker so an echoed prompt can't trip the match.
    const scanText = s.content.split("Using prompt:")[0];
    for (const line of scanText.split("\n")) {
      if (QUOTA_ERROR_RE.test(line)) return line.trim();
    }
  }
  return null;
}

// Google's geo/ASN gate on the model-call path. Real form, seen only in
// agy's server log (`~/.gemini/antigravity-cli/log/cli-<ts>.log`), not in
// the run's brain-dir transcript and not in the stdout JSON (whose
// top-level `error` on this path is the generic "Agent execution
// terminated due to error."):
//   agent executor error: calling model: FAILED_PRECONDITION (code 400):
//   User location is not supported for the API use.
// The phrase is specific enough to match on its own; kept anchored to the
// distinctive "for the API use" tail so a prompt that merely mentions
// "location is not supported" can't trip it.
const LOCATION_ERROR_RE = /user location is not supported for the API use/i;

// Scan an arbitrary text blob (a server-log tail, or a transcript step's
// content) line by line for the geo-gate signature. Returns the first
// matching line, trimmed, or null. Pure + fs-free so it's unit-testable
// without a real agy install.
export function detectLocationError(text: string): string | null {
  if (!text) return null;
  for (const line of text.split("\n")) {
    if (LOCATION_ERROR_RE.test(line)) return line.trim();
  }
  return null;
}

// Same gate, but reading agy's own transcript diagnostic channels — a
// forward hedge in case agy starts surfacing it there like it now does for
// quota. Same step-type allowlist and "Using prompt:" guard as
// detectQuotaError so an echoed prompt can't trip it.
export function detectLocationErrorInSteps(steps: TranscriptStep[]): string | null {
  for (const s of steps) {
    if (!s.content || !QUOTA_SCAN_TYPES.has(s.type)) continue;
    const scanText = s.content.split("Using prompt:")[0];
    const hit = detectLocationError(scanText);
    if (hit) return hit;
  }
  return null;
}
