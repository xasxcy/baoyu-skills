import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runAgyExec, buildStatusErrorMessage, readServerLogForConversation } from "./spawn.ts";
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

// --- readServerLogForConversation: picks THIS run's cli-*.log by id, recent only ---

async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "agy-spawn-home-"));
  const orig = process.env._AGY_IMAGEGEN_TEST_HOME;
  process.env._AGY_IMAGEGEN_TEST_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (orig === undefined) delete process.env._AGY_IMAGEGEN_TEST_HOME;
    else process.env._AGY_IMAGEGEN_TEST_HOME = orig;
    await rm(home, { recursive: true, force: true });
  }
}

async function writeLog(home: string, name: string, body: string, ageMs = 0): Promise<void> {
  const dir = path.join(home, "log");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, body, "utf-8");
  if (ageMs > 0) {
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }
}

const GEO_LINE =
  "E0904 errorreport.go:224] agent executor error: calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use.";

test("readServerLogForConversation returns the in-window log that mentions the conversation id", async () => {
  await withFakeHome(async (home) => {
    await writeLog(home, "cli-a.log", `Streaming conversation other-id\n${GEO_LINE}\n`);
    await writeLog(home, "cli-b.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`);
    const out = await readServerLogForConversation("conv-XYZ", Date.now() - 60_000);
    expect(out).toContain("conv-XYZ");
    expect(out).toContain("User location is not supported");
  });
});

test("readServerLogForConversation joins every in-window id-matching log, so the geo line is not lost to a companion log", async () => {
  await withFakeHome(async (home) => {
    // A real `agy -p` run writes several cli-*.log files; the id can appear
    // in one that has no error line, with the geo line in another.
    await writeLog(home, "cli-startup.log", "Streaming conversation conv-XYZ\nauth ok, no errors here\n", 20_000);
    await writeLog(home, "cli-stream.log", `handling conv-XYZ\n${GEO_LINE}\n`);
    const out = await readServerLogForConversation("conv-XYZ", Date.now() - 60_000);
    expect(out).toContain("User location is not supported");
  });
});

test("readServerLogForConversation ignores an id-matching log older than the run-start bound", async () => {
  await withFakeHome(async (home) => {
    await writeLog(home, "cli-old.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`, 30 * 60 * 1000);
    expect(await readServerLogForConversation("conv-XYZ", Date.now())).toBeNull();
  });
});

// Codex adversarial-review regression (rounds 1-4): earlier revisions
// capped the file set (newest 12, then 200) *before* correlating to the
// conversation id, so enough concurrent unrelated `agy` runs could crowd
// this run's log out and the geo gate silently downgraded to a retryable
// failure. Enumeration is now streamed + bounded (newestLogNames), but
// there is still no content-correlation cap below the pathological-dir
// ceilings — every file in the (mandatory, run-lifetime) mtime window is
// content-checked, so a match behind hundreds of unrelated logs survives.
test("readServerLogForConversation still finds the id-matching log behind 300 unrelated logs", async () => {
  await withFakeHome(async (home) => {
    for (let i = 0; i < 300; i++) {
      const stamp = String(i).padStart(5, "0");
      await writeLog(home, `cli-2026_${stamp}.log`, `Streaming conversation other-${i}\n${GEO_LINE}\n`);
    }
    // Newest by name and inside the run-start window.
    await writeLog(home, "cli-2026_99999.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`, 5_000);
    const out = await readServerLogForConversation("conv-XYZ", Date.now() - 60_000);
    expect(out).toContain("User location is not supported");
    expect(out).not.toContain("other-0");
  });
});

test("readServerLogForConversation ignores an id-matching log written before the run-start bound", async () => {
  await withFakeHome(async (home) => {
    // A prior run's log, 10 min ago (id collisions can't really happen —
    // ids are fresh per run — but the bound must still exclude it).
    await writeLog(home, "cli-prior.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`, 10 * 60 * 1000);
    const sinceMs = Date.now() - 5 * 60 * 1000;
    expect(await readServerLogForConversation("conv-XYZ", sinceMs)).toBeNull();

    // Same id, written after the bound → picked up.
    await writeLog(home, "cli-current.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`);
    expect(await readServerLogForConversation("conv-XYZ", sinceMs)).toContain(
      "User location is not supported",
    );
  });
});

test("readServerLogForConversation reads a large log via head+tail so an early id and a late geo line are both seen", async () => {
  await withFakeHome(async (home) => {
    // > SERVER_LOG_WHOLE_MAX_BYTES (2 MiB): id header near the start, geo
    // line at the very end, 3 MiB of filler between them.
    const filler = "x".repeat(3 * 1024 * 1024);
    await writeLog(
      home,
      "cli-huge.log",
      `Streaming conversation conv-XYZ\n${filler}\n${GEO_LINE}\n`,
    );
    const out = await readServerLogForConversation("conv-XYZ", Date.now() - 60_000);
    expect(out).toContain("User location is not supported");
  });
});

// Codex adversarial-review regression (round 2): a coarse-granularity
// filesystem can stamp a log created microseconds after the spawn instant
// with an mtime rounded DOWN to just below `sinceMs`. The grace window must
// still admit it.
test("readServerLogForConversation admits an id-matching log whose mtime is just below the run-start bound (mtime grace)", async () => {
  await withFakeHome(async (home) => {
    const sinceMs = Date.now();
    // 1s before the bound — inside the 2s grace, so it must still be found.
    await writeLog(home, "cli-rounded-down.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`, 1_000);
    const out = await readServerLogForConversation("conv-XYZ", sinceMs);
    expect(out).toContain("User location is not supported");
  });
});

test("readServerLogForConversation still rejects an id-matching log well outside the grace window", async () => {
  await withFakeHome(async (home) => {
    const sinceMs = Date.now();
    // 10s before the bound — well past the 2s grace.
    await writeLog(home, "cli-too-old.log", `Streaming conversation conv-XYZ\n${GEO_LINE}\n`, 10_000);
    expect(await readServerLogForConversation("conv-XYZ", sinceMs)).toBeNull();
  });
});

test("readServerLogForConversation returns null when the log dir is absent", async () => {
  await withFakeHome(async () => {
    expect(await readServerLogForConversation("conv-XYZ", Date.now() - 60_000)).toBeNull();
  });
});
