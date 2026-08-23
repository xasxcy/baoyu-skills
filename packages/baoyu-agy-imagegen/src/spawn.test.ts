import { test, expect } from "bun:test";
import { runAgyExec, buildStatusErrorMessage } from "./spawn.ts";
import { GenError } from "./types.ts";

test("runAgyExec maps a missing `agy` binary to agy_not_installed, not a retryable spawn_failed", async () => {
  const origPath = process.env.PATH;
  // Point PATH somewhere with no `agy` binary so spawn() hits ENOENT,
  // exercising the same failure mode as agy not being installed at all.
  process.env.PATH = "/nonexistent-agy-imagegen-test-path";
  try {
    let caught: unknown;
    try {
      await runAgyExec({ instruction: "test", model: "gemini-3.7-flash-medium", timeoutMs: 5000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GenError);
    expect((caught as GenError).kind).toBe("agy_not_installed");
    expect((caught as GenError).retryable).toBe(false);
  } finally {
    process.env.PATH = origPath;
  }
});

// Real (sanitized) `agy -p ... --output-format json` stdout for a 429
// captured from a live run: agy's own quota pool (cloudcode-pa.googleapis.com
// / gemini-3.1-flash-image) is exhausted, distinct from any Vertex quota
// baoyu-image-gen manages itself. `response` is a meaningless "OK" here —
// `error` carries the only useful diagnostic text.
test("buildStatusErrorMessage surfaces the real `error` field (e.g. a 429 RESOURCE_EXHAUSTED body), not just the placeholder `response`", () => {
  const msg = buildStatusErrorMessage({
    status: "ERROR",
    response: "OK",
    error:
      'failed to generate content: 429 Too Many Requests, body: {\n  "error": {\n    "code": 429,\n    "message": "You have exhausted your capacity on this model. Your quota will reset after 2s.",\n    "status": "RESOURCE_EXHAUSTED",\n    "details": [{"@type":"...ErrorInfo","reason":"RATE_LIMIT_EXCEEDED","domain":"cloudcode-pa.googleapis.com","metadata":{"quotaResetDelay":"2.29s","model":"gemini-3.1-flash-image"}}]\n  }\n}\n',
  });
  expect(msg).toContain("status=ERROR");
  expect(msg).toContain("RESOURCE_EXHAUSTED");
  expect(msg).toContain("RATE_LIMIT_EXCEEDED");
  expect(msg).toContain("429 Too Many Requests");
});

test("buildStatusErrorMessage falls back to status+response alone when `error` is absent", () => {
  const msg = buildStatusErrorMessage({ status: "ERROR", response: "content policy violation" });
  expect(msg).toBe("agy reported status=ERROR: content policy violation");
});

test("buildStatusErrorMessage tolerates a missing response too", () => {
  const msg = buildStatusErrorMessage({ status: "ERROR" });
  expect(msg).toBe("agy reported status=ERROR: ");
});
