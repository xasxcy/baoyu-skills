import { test, expect } from "bun:test";
import { runAgyExec } from "./spawn.ts";
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
