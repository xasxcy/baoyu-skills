import { test, expect } from "bun:test";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { JsonLogger } from "./logger.ts";

test("log() writes an entry when the log file is writable", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-logger-"));
  try {
    const logFile = path.join(dir, "out.jsonl");
    const logger = new JsonLogger(logFile, false);
    await logger.info("start", { foo: "bar" });
    const content = await readFile(logFile, "utf-8");
    expect(content).toContain('"event":"start"');
    expect(content).toContain('"foo":"bar"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("log() is best-effort — an unwritable log path does not throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-logger-"));
  try {
    // A file where the logger expects a writable directory: mkdir(recursive)
    // on a path through this file fails, exercising the write-failure path
    // that used to propagate out of main()'s error handler and prevent the
    // fallback stdout JSON from ever being written.
    const blockingFile = path.join(dir, "not-a-directory");
    await writeFile(blockingFile, "x");
    const logFile = path.join(blockingFile, "nested", "out.jsonl");
    const logger = new JsonLogger(logFile, false);
    await expect(logger.info("start", {})).resolves.toBeUndefined();
    await expect(logger.error("failed", { kind: "spawn_failed" })).resolves.toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
