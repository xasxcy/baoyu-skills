import { test, expect } from "bun:test";
import {
  parseAgyStdout,
  toTokenUsage,
  parseTranscript,
  unwrapToolCallArg,
  hasGenerateImageInvocation,
  extractSavedImagePath,
} from "./parser.ts";

// Real (sanitized) `agy -p ... --output-format json` stdout, captured from a
// live run. The response field contains a raw, unescaped newline — agy does
// not escape control characters in its JSON output, which both V8's and
// Python's strict JSON parsers reject.
const REAL_STDOUT_WITH_BARE_NEWLINE =
  '{"conversation_id":"ef5b7ecf-0bce-4963-8aa7-154d4e7b3481","status":"SUCCESS","response":"已成功调用 `generate_image` 工具生成绿色三角形图标（`probe_green_triangle`）。\n","duration_seconds":13.376872,"num_turns":1,"usage":{"input_tokens":20355,"output_tokens":308,"thinking_tokens":216,"cache_read_tokens":16286,"total_tokens":20663}}';

test("parseAgyStdout falls back to sanitizing when stdout has a bare control char", () => {
  const parsed = parseAgyStdout(REAL_STDOUT_WITH_BARE_NEWLINE);
  expect(parsed.conversation_id).toBe("ef5b7ecf-0bce-4963-8aa7-154d4e7b3481");
  expect(parsed.status).toBe("SUCCESS");
  expect(parsed.response).toContain("generate_image");
});

test("parseAgyStdout parses clean JSON on the fast path", () => {
  const clean = '{"conversation_id":"abc","status":"SUCCESS","response":"ok"}';
  expect(parseAgyStdout(clean).conversation_id).toBe("abc");
});

test("parseAgyStdout throws on empty stdout", () => {
  expect(() => parseAgyStdout("   ")).toThrow(/empty stdout/);
});

test("parseAgyStdout sanitizes a bare control char without corrupting pretty-printed structure", () => {
  // Structural newlines/indentation between tokens must survive; only the
  // bare control char *inside* the string value should be escaped.
  const prettyWithBareNewline =
    '{\n  "conversation_id": "abc",\n  "status": "SUCCESS",\n  "response": "line1\nline2"\n}';
  const parsed = parseAgyStdout(prettyWithBareNewline);
  expect(parsed.conversation_id).toBe("abc");
  expect(parsed.response).toBe("line1\nline2");
});

test("toTokenUsage maps agy's field names", () => {
  const usage = toTokenUsage({
    input_tokens: 100,
    output_tokens: 20,
    thinking_tokens: 5,
    cache_read_tokens: 50,
    total_tokens: 175,
  });
  expect(usage).toEqual({ input: 100, cached_input: 50, output: 20, thinking: 5 });
  expect(toTokenUsage(undefined)).toBeNull();
});

// Real (sanitized) transcript.jsonl for a successful generate_image run.
// Captured from ~/.gemini/antigravity-cli/brain/<conversation_id>/
// .system_generated/logs/transcript.jsonl.
const REAL_TRANSCRIPT = [
  '{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","created_at":"2026-08-18T09:42:09Z","content":"request"}',
  '{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE","created_at":"2026-08-18T09:42:09Z"}',
  '{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-18T09:42:09Z","tool_calls":[{"name":"generate_image","args":{"AspectRatio":"\\"1:1\\"","ImageName":"\\"probe_green_triangle\\"","Prompt":"\\"A simple green triangle icon.\\"","toolAction":"\\"Generating image\\"","toolSummary":"\\"Image generation\\""}}]}',
  '{"step_index":3,"source":"MODEL","type":"GENERATE_IMAGE","status":"DONE","created_at":"2026-08-18T09:42:12Z","content":"Created At: 2026-08-18T17:42:12+08:00\\nCompleted At: 2026-08-18T17:42:18+08:00\\nUsing prompt: A simple green triangle icon.\\n\\nGenerated image is saved at /Users/x/.gemini/antigravity-cli/brain/ef5b7ecf-0bce-4963-8aa7-154d4e7b3481/probe_green_triangle_1787046138620.jpg.\\n\\n Do not output the path of this image to show to the user since the user can already see it."}',
  '{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","created_at":"2026-08-18T09:42:18Z","content":"已成功调用 generate_image。"}',
].join("\n");

test("parseTranscript parses one step per line", () => {
  const steps = parseTranscript(REAL_TRANSCRIPT);
  expect(steps).toHaveLength(5);
  expect(steps[2].tool_calls?.[0].name).toBe("generate_image");
});

test("parseTranscript skips malformed lines instead of throwing", () => {
  const steps = parseTranscript('{"step_index":0}\nnot json\n{"step_index":1}');
  expect(steps).toHaveLength(2);
});

test("unwrapToolCallArg unwraps agy's double-JSON-encoded values", () => {
  const steps = parseTranscript(REAL_TRANSCRIPT);
  const args = steps[2].tool_calls![0].args;
  expect(unwrapToolCallArg(args.AspectRatio)).toBe("1:1");
  expect(unwrapToolCallArg(args.ImageName)).toBe("probe_green_triangle");
  expect(unwrapToolCallArg(undefined)).toBeNull();
});

test("hasGenerateImageInvocation detects the GENERATE_IMAGE step", () => {
  const steps = parseTranscript(REAL_TRANSCRIPT);
  expect(hasGenerateImageInvocation(steps)).toBe(true);
  expect(hasGenerateImageInvocation(parseTranscript('{"step_index":0,"status":"DONE","type":"PLANNER_RESPONSE"}'))).toBe(false);
});

test("extractSavedImagePath pulls the exact saved-file path from the transcript", () => {
  const steps = parseTranscript(REAL_TRANSCRIPT);
  expect(extractSavedImagePath(steps)).toBe(
    "/Users/x/.gemini/antigravity-cli/brain/ef5b7ecf-0bce-4963-8aa7-154d4e7b3481/probe_green_triangle_1787046138620.jpg",
  );
});

test("extractSavedImagePath returns null when no GENERATE_IMAGE step exists", () => {
  expect(extractSavedImagePath(parseTranscript('{"step_index":0,"status":"DONE","type":"PLANNER_RESPONSE"}'))).toBeNull();
});

test("extractSavedImagePath matches without a trailing sentence period", () => {
  const step = '{"step_index":0,"status":"DONE","type":"GENERATE_IMAGE","content":"Generated image is saved at /tmp/x/out.jpg\\n\\nDone."}';
  expect(extractSavedImagePath(parseTranscript(step))).toBe("/tmp/x/out.jpg");
});

test("extractSavedImagePath matches a quoted path containing spaces", () => {
  const step = '{"step_index":0,"status":"DONE","type":"GENERATE_IMAGE","content":"Generated image is saved at \\"/tmp/my folder/out.png\\"."}';
  expect(extractSavedImagePath(parseTranscript(step))).toBe("/tmp/my folder/out.png");
});
