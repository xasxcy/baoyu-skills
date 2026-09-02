import assert from "node:assert/strict";
import test from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildWrapperError,
  getDefaultModel,
  getDefaultOutputExtension,
  validateArgs,
} from "./agy-cli.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: "agy-cli",
    model: null,
    aspectRatio: null,
    aspectRatioSource: null,
    size: null,
    quality: "2k",
    imageSize: null,
    imageSizeSource: null,
    imageApiDialect: null,
    referenceImages: [],
    n: 1,
    batchFile: null,
    jobs: null,
    json: false,
    help: false,
    ...overrides,
  };
}

test("agy-cli defaults to gemini-3.7-flash-medium model and JPEG output", () => {
  assert.equal(getDefaultModel(), "gemini-3.7-flash-medium");
  assert.equal(getDefaultOutputExtension(), ".jpg");
});

test("agy-cli validateArgs rejects n>1 with a non-retryable message", () => {
  assert.throws(
    () => validateArgs("gemini-3.7-flash-medium", makeArgs({ n: 2 })),
    /supports only n=1/,
  );
});

test("agy-cli validateArgs rejects ratio-metadata dialect", () => {
  assert.throws(
    () => validateArgs("gemini-3.7-flash-medium", makeArgs({ imageApiDialect: "ratio-metadata" })),
    /Invalid imageApiDialect/,
  );
});

test("agy-cli validateArgs accepts default n=1 with no dialect", () => {
  assert.doesNotThrow(() => validateArgs("gemini-3.7-flash-medium", makeArgs()));
});

test("agy-cli validateArgs accepts up to 3 reference images", () => {
  assert.doesNotThrow(() =>
    validateArgs("gemini-3.7-flash-medium", makeArgs({ referenceImages: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg"] })),
  );
});

test("agy-cli validateArgs rejects more than 3 reference images", () => {
  assert.throws(
    () =>
      validateArgs(
        "gemini-3.7-flash-medium",
        makeArgs({ referenceImages: ["/tmp/a.jpg", "/tmp/b.jpg", "/tmp/c.jpg", "/tmp/d.jpg"] }),
      ),
    /at most 3 reference images/,
  );
});

test("agy-cli buildWrapperError marks a 429/RESOURCE_EXHAUSTED refusal as retryable (no 'Invalid ' prefix) and keeps the real error text", () => {
  const err = buildWrapperError({
    status: "error",
    path: "",
    bytes: 0,
    error_kind: "agent_refused",
    error:
      'agy reported status=ERROR:  | error: failed to generate content: 429 Too Many Requests, body: {"error":{"code":429,"message":"You have exhausted your capacity on this model.","status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED"}]}}',
  });
  assert.doesNotMatch(err.message, /^Invalid /);
  assert.match(err.message, /RESOURCE_EXHAUSTED/);
  assert.match(err.message, /429 Too Many Requests/);
});

test("agy-cli buildWrapperError routes error_kind=quota_exhausted into the retryable rate-limit path", () => {
  const err = buildWrapperError({
    status: "error",
    path: "",
    bytes: 0,
    error_kind: "quota_exhausted",
    error:
      "调用 generate_image 生成图片失败：当前模型的配额已耗尽（429 Resource Exhausted / QUOTA_EXHAUSTED），请稍后重试。",
  });
  assert.doesNotMatch(err.message, /^Invalid /);
  assert.match(err.message, /agy-cli rate limited \(quota_exhausted\)/);
  assert.match(err.message, /QUOTA_EXHAUSTED/);
});

test("agy-cli buildWrapperError keeps a genuine (non-rate-limit) agent_refused non-retryable, with error text preserved", () => {
  const err = buildWrapperError({
    status: "error",
    path: "",
    bytes: 0,
    error_kind: "agent_refused",
    error: "agy reported status=ERROR: content policy violation, cannot generate this image",
  });
  assert.match(err.message, /^Invalid agy-cli result \(agent_refused\)/);
  assert.match(err.message, /content policy violation/);
});

test("agy-cli buildWrapperError keeps other error_kinds non-retryable and preserves their message", () => {
  const err = buildWrapperError({
    status: "error",
    path: "",
    bytes: 0,
    error_kind: "timeout",
    error: "agy exceeded 300000ms (log: /tmp/agy-imggen-xyz/stdout.json)",
  });
  assert.match(err.message, /^Invalid agy-cli result \(timeout\)/);
  assert.match(err.message, /agy exceeded 300000ms/);
});

test("agy-cli buildWrapperError handles a missing error field without throwing", () => {
  const err = buildWrapperError({
    status: "error",
    path: "",
    bytes: 0,
    error_kind: "malformed_json",
  } as any);
  assert.match(err.message, /^Invalid agy-cli result \(malformed_json\)/);
});
