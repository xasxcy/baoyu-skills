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
