import assert from "node:assert/strict";
import test from "node:test";

import {
  detectQuotaError,
  extractSavedImagePath,
  hasGenerateImageInvocation,
  parseTranscript,
  type TranscriptStep,
} from "./parser.ts";

function step(overrides: Partial<TranscriptStep>): TranscriptStep {
  return {
    step_index: 0,
    source: "planner",
    type: "GENERIC",
    status: "DONE",
    ...overrides,
  };
}

// A trimmed but field-accurate sample of the CURRENT agy transcript format
// (see DIAGNOSIS.md): a PLANNER_RESPONSE carrying the generate_image
// tool_call, a GENERIC step with timing text but NO saved path, then "OK".
const NEW_FORMAT_SUCCESS: TranscriptStep[] = [
  step({
    step_index: 0,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [{ name: "generate_image", args: { AspectRatio: '"1:1"', ImageName: '"agy_imagegen_output"' } }],
  }),
  step({
    step_index: 1,
    source: "tool",
    type: "GENERIC",
    status: "DONE",
    content: "Created At: 2026-09-02T10:00:00Z\nCompleted At: 2026-09-02T10:00:21Z\nUsing prompt: a red bicycle",
  }),
  step({ step_index: 2, type: "PLANNER_RESPONSE", status: "DONE", content: "OK" }),
];

// The OLD format the original parser was written against.
const OLD_FORMAT_SUCCESS: TranscriptStep[] = [
  step({
    step_index: 0,
    type: "PLANNER_RESPONSE",
    status: "DONE",
    tool_calls: [{ name: "generate_image", args: {} }],
  }),
  step({
    step_index: 1,
    source: "tool",
    type: "GENERATE_IMAGE",
    status: "DONE",
    content: 'Image saved at "/home/u/.gemini/antigravity-cli/brain/abc/agy_imagegen_output.png".',
  }),
];

test("hasGenerateImageInvocation: new format (PLANNER_RESPONSE + generate_image tool_call, DONE) is recognized", () => {
  assert.equal(hasGenerateImageInvocation(NEW_FORMAT_SUCCESS), true);
});

test("hasGenerateImageInvocation: old GENERATE_IMAGE step still recognized", () => {
  assert.equal(hasGenerateImageInvocation(OLD_FORMAT_SUCCESS), true);
});

test("hasGenerateImageInvocation: no generate_image tool_call anywhere is false", () => {
  const steps = [
    step({ type: "USER_INPUT", source: "user", content: "draw a cat" }),
    step({ step_index: 1, type: "PLANNER_RESPONSE", content: "I cannot do that." }),
  ];
  assert.equal(hasGenerateImageInvocation(steps), false);
});

test("extractSavedImagePath: old 'saved at ...png' text still parsed (fallback regression)", () => {
  assert.equal(
    extractSavedImagePath(OLD_FORMAT_SUCCESS),
    "/home/u/.gemini/antigravity-cli/brain/abc/agy_imagegen_output.png",
  );
});

test("extractSavedImagePath: new format has no saved-path text -> null", () => {
  assert.equal(extractSavedImagePath(NEW_FORMAT_SUCCESS), null);
});

test("detectQuotaError: 429 / QUOTA_EXHAUSTED text in a PLANNER_RESPONSE step is surfaced", () => {
  const steps = [
    step({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "generate_image", args: {} }] }),
    step({
      step_index: 1,
      type: "PLANNER_RESPONSE",
      content:
        "调用 generate_image 生成图片失败：当前模型的配额已耗尽（429 Resource Exhausted / QUOTA_EXHAUSTED），请稍后重试。",
    }),
  ];
  const hit = detectQuotaError(steps);
  assert.ok(hit && /QUOTA_EXHAUSTED/.test(hit));
});

test("detectQuotaError: clean success transcript -> null", () => {
  assert.equal(detectQuotaError(NEW_FORMAT_SUCCESS), null);
});

test("detectQuotaError: a '429' that appears only in the echoed USER_INPUT prompt is ignored", () => {
  const steps = [
    step({ type: "USER_INPUT", source: "user", content: "make a poster explaining HTTP 429 RESOURCE_EXHAUSTED errors" }),
    step({ step_index: 1, type: "PLANNER_RESPONSE", tool_calls: [{ name: "generate_image", args: {} }] }),
    step({ step_index: 2, type: "GENERIC", content: "Created At: x\nCompleted At: y" }),
  ];
  assert.equal(detectQuotaError(steps), null);
});

test("detectQuotaError: a '429' in a GENERIC step's echoed 'Using prompt:' text is ignored", () => {
  const steps = [
    step({ type: "PLANNER_RESPONSE", tool_calls: [{ name: "generate_image", args: {} }] }),
    step({
      step_index: 1,
      source: "tool",
      type: "GENERIC",
      content: "Created At: x\nCompleted At: y\nUsing prompt: a poster about HTTP 429 and RESOURCE_EXHAUSTED errors",
    }),
    step({ step_index: 2, type: "PLANNER_RESPONSE", content: "OK" }),
  ];
  assert.equal(detectQuotaError(steps), null);
});

test("parseTranscript: skips malformed JSONL lines rather than failing the whole transcript", () => {
  const raw = '{"step_index":0,"source":"s","type":"PLANNER_RESPONSE","status":"DONE"}\nnot json\n{"step_index":1,"source":"s","type":"GENERIC","status":"DONE"}';
  const steps = parseTranscript(raw);
  assert.equal(steps.length, 2);
  assert.equal(steps[1].type, "GENERIC");
});
