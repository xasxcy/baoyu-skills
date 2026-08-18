import assert from "node:assert/strict";
import test from "node:test";

import type { CliArgs } from "../types.ts";
import {
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
