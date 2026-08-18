import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { snapshotRefs } from "./main.ts";
import { cacheKey } from "./cache.ts";

test("snapshotRefs copies each ref's current bytes to a private path", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const a = path.join(dir, "a.jpg");
    const b = path.join(dir, "b.png");
    await writeFile(a, "content-a");
    await writeFile(b, "content-b");

    const { paths, cleanup } = await snapshotRefs([a, b]);
    try {
      expect(paths).toHaveLength(2);
      expect(paths[0]).not.toBe(a);
      expect(paths[1]).not.toBe(b);
      expect((await readFile(paths[0], "utf-8"))).toBe("content-a");
      expect((await readFile(paths[1], "utf-8"))).toBe("content-b");

      // Mutating the original after snapshotting must not affect the copy —
      // this is exactly the TOCTOU window the snapshot exists to close.
      await writeFile(a, "content-a-CHANGED");
      expect((await readFile(paths[0], "utf-8"))).toBe("content-a");
    } finally {
      await cleanup();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotRefs with no refs is a no-op that returns an empty list", async () => {
  const { paths, cleanup } = await snapshotRefs([]);
  expect(paths).toEqual([]);
  await expect(cleanup()).resolves.toBeUndefined();
});

test("snapshotRefs cleanup removes the snapshot directory", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const a = path.join(dir, "a.jpg");
    await writeFile(a, "content-a");
    const { paths, cleanup } = await snapshotRefs([a]);
    const snapshotDir = path.dirname(paths[0]);
    await cleanup();
    await expect(readFile(paths[0])).rejects.toThrow();
    await expect(readFile(snapshotDir)).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("snapshotRefs cleans up its own tmp dir if a copy fails partway through", async () => {
  const { readdir } = await import("node:fs/promises");
  const dir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const a = path.join(dir, "a.jpg");
    const missing = path.join(dir, "does-not-exist.jpg");
    await writeFile(a, "content-a");

    const leaksBefore = (await readdir(tmpdir())).filter((n) => n.startsWith("agy-imggen-refs-"));

    await expect(snapshotRefs([a, missing])).rejects.toThrow(/ENOENT|no such file/i);

    // The tmp dir snapshotRefs created internally (with `a` already copied
    // in before the second, missing ref made the copy loop throw) must not
    // survive — there is no cleanup callback for the caller to invoke,
    // since the function never got to return one on this path.
    const leaksAfter = (await readdir(tmpdir())).filter((n) => n.startsWith("agy-imggen-refs-"));
    expect(leaksAfter.length).toBe(leaksBefore.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Regression: the round-3 TOCTOU fix (snapshot refs into a fresh mkdtemp dir
// per run before hashing) broke caching entirely for ref-bearing requests,
// because the snapshot path is a different random tmp path every single
// invocation and cacheKey used to hash the path alongside the content.
// Byte-identical refs at different (snapshot) paths must produce the same
// key, or every ref-backed call permanently misses the cache.
test("cacheKey ignores the ref path — identical content at different snapshot paths yields the same key", async () => {
  const srcDir = await mkdtemp(path.join(tmpdir(), "agy-snapshot-src-"));
  try {
    const original = path.join(srcDir, "character.jpg");
    await writeFile(original, "same bytes");

    const snap1 = await snapshotRefs([original]);
    const snap2 = await snapshotRefs([original]);
    try {
      expect(snap1.paths[0]).not.toBe(snap2.paths[0]); // different mkdtemp runs
      const k1 = await cacheKey("hello", "1:1", "gemini-3.7-flash-medium", snap1.paths);
      const k2 = await cacheKey("hello", "1:1", "gemini-3.7-flash-medium", snap2.paths);
      expect(k1).toBe(k2);
    } finally {
      await snap1.cleanup();
      await snap2.cleanup();
    }
  } finally {
    await rm(srcDir, { recursive: true, force: true });
  }
});
