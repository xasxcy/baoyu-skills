export interface CliOptions {
  prompt: string;
  promptFile: string | null;
  outputPath: string;
  aspect: string;
  refImages: string[];
  model: string;
  timeoutMs: number;
  retries: number;
  retryDelayMs: number;
  cacheDir: string | null;
  logFile: string | null;
  verbose: boolean;
}

export interface TokenUsage {
  input: number;
  cached_input: number;
  output: number;
  thinking: number;
}

export interface AgyRunResult {
  conversationId: string | null;
  responseText: string | null;
  usage: TokenUsage | null;
  rawLogPath: string;
  durationMs: number;
  // Wall-clock ms just before this run's `agy` process was spawned. Every
  // server-side `cli-*.log` file for this run is created at/after this
  // instant, so it's the (mandatory) lower bound — applied with a small
  // filesystem-mtime grace — that bounds the geo-gate log scan to this
  // run's own lifetime, keeping it correct and cheap even when other `agy`
  // invocations write to the same log dir concurrently. See
  // readServerLogForConversation.
  startedAtMs: number;
  // agy's own top-level status (e.g. "SUCCESS", "ERROR"). Defaults to
  // "SUCCESS" when agy omits the field, matching agy's own implicit
  // success-unless-stated-otherwise convention. Callers decide what to do
  // with a non-SUCCESS status — this wrapper no longer throws on it, since
  // agy can report ERROR (e.g. an internal 429) even after generate_image
  // actually ran and saved a file.
  status: string;
  // agy's raw `error` field, verbatim. This is where agy puts the real
  // diagnostic text (response is often an empty/meaningless placeholder on
  // a non-SUCCESS status) — null when agy didn't set one (typically SUCCESS).
  rawError: string | null;
}

export interface GenerateResult {
  status: "ok" | "error";
  path: string;
  bytes: number;
  elapsed_seconds: number;
  conversation_id: string | null;
  attempts: number;
  cached: boolean;
  usage: TokenUsage | null;
  error?: string;
  error_kind?: ErrorKind;
}

export type ErrorKind =
  | "agy_not_installed"
  | "invalid_args"
  | "prompt_file_missing"
  | "spawn_failed"
  | "timeout"
  | "no_image_gen_tool_use"
  | "output_missing"
  | "invalid_jpeg"
  | "quota_exhausted"
  | "location_not_supported"
  | "agent_refused"
  | "malformed_json";

export const RETRYABLE: ReadonlySet<ErrorKind> = new Set([
  "spawn_failed",
  "timeout",
  "no_image_gen_tool_use",
  "output_missing",
  "invalid_jpeg",
  // agy's upstream image quota resets on a short delay (seconds), so a
  // retry with backoff can succeed — unlike a content refusal.
  "quota_exhausted",
  "agent_refused",
  "malformed_json",
]);

// Deliberately NOT in RETRYABLE: "location_not_supported" is Google's
// geo/ASN gate on the model-call path (`FAILED_PRECONDITION (code 400):
// User location is not supported for the API use`). It's a property of the
// egress IP, not the request — retrying from the same network only burns
// time. The fix is to change the exit (a supported region, ideally a
// residential/ISP IP rather than a datacenter range), which no amount of
// in-process retry can do.

export class GenError extends Error {
  attempts?: number;
  constructor(public kind: ErrorKind, message: string, public retryable?: boolean) {
    super(message);
    this.retryable = retryable ?? RETRYABLE.has(kind);
  }
}
