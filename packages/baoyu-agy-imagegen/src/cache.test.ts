import { test, expect } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheKey, lookupCache, storeCache } from "./cache.ts";

async function withRefs(dir: string, contents: Record<string, string>): Promise<Record<string, string>> {
  const paths: Record<string, string> = {};
  for (const [name, content] of Object.entries(contents)) {
    const p = path.join(dir, name);
    await writeFile(p, content);
    paths[name] = p;
  }
  return paths;
}

test("cacheKey varies with prompt, aspect, and model", async () => {
  const k1 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", []);
  const k2 = await cacheKey("hello", "1:1", "gemini-3.7-flash-medium", []);
  expect(k2).not.toBe(k1);
  const k3 = await cacheKey("hello", "16:9", "claude-sonnet-4-6", []);
  expect(k3).not.toBe(k1);
  const k4 = await cacheKey("bye", "16:9", "gemini-3.7-flash-medium", []);
  expect(k4).not.toBe(k1);
});

test("cacheKey does not collide across a prompt-boundary shift", async () => {
  const k1 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", []);
  const k2 = await cacheKey("hell", "o16:9", "gemini-3.7-flash-medium", []);
  expect(k1).not.toBe(k2);
});

test("cacheKey is sensitive to reference-image order (order is meaningful to the model)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-cachekey-"));
  try {
    const refs = await withRefs(dir, { a: "subject", b: "style" });
    const k1 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", [refs.a, refs.b]);
    const k2 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", [refs.b, refs.a]);
    expect(k1).not.toBe(k2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cacheKey changes when a reference file at the same path is overwritten with different content", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-cachekey-"));
  try {
    const refPath = path.join(dir, "character.jpg");
    await writeFile(refPath, "original content");
    const k1 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", [refPath]);
    await writeFile(refPath, "replaced content");
    const k2 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", [refPath]);
    expect(k1).not.toBe(k2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cacheKey is deterministic for identical inputs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-cachekey-"));
  try {
    const refs = await withRefs(dir, { a: "subject" });
    const k1 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", [refs.a]);
    const k2 = await cacheKey("hello", "16:9", "gemini-3.7-flash-medium", [refs.a]);
    expect(k1).toBe(k2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("lookupCache returns null on miss, path on hit", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-cache-"));
  try {
    expect(await lookupCache(dir, "abc")).toBeNull();
    const fake = path.join(dir, "abc.jpg");
    await writeFile(fake, Buffer.alloc(2000));
    expect(await lookupCache(dir, "abc")).toBe(fake);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("storeCache copies source into cache", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "agy-cache-"));
  const src = path.join(dir, "src.jpg");
  try {
    await writeFile(src, Buffer.from("xxxx".repeat(1000)));
    await storeCache(dir, "key1", src);
    const cached = await lookupCache(dir, "key1");
    expect(cached).not.toBeNull();
    const a = await readFile(src);
    const b = await readFile(cached!);
    expect(a.equals(b)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
