import { createHash } from "node:crypto";
import { mkdir, copyFile, rename, stat, unlink, readFile } from "node:fs/promises";
import path from "node:path";

// Ref order is semantically meaningful — buildInstruction tells the model
// "pass these absolute paths as ImagePaths in this order" — so the key must
// NOT sort refs (unlike a plain deduplication key, where order wouldn't
// matter). It hashes only each ref's actual bytes, never its path: when
// --cache-dir is set, callers pass paths into a fresh mkdtemp snapshot
// directory (main.ts's snapshotRefs) so the on-disk bytes can't change out
// from under the key between hashing and use — but that means the path
// string is a different random tmp path on every single invocation. Hashing
// it would make the key different every time even for byte-identical refs,
// permanently missing the cache for every ref-bearing request. Content is
// also the more correct identity anyway: two different files with identical
// bytes should produce (and reuse) the same generation.
export async function cacheKey(prompt: string, aspect: string, model: string, refs: string[]): Promise<string> {
  const h = createHash("sha256");
  h.update(prompt);
  h.update("|");
  h.update(aspect);
  h.update("|");
  h.update(model);
  h.update("|");
  for (const r of refs) {
    h.update(await readFile(r));
    h.update("|");
  }
  return h.digest("hex").slice(0, 16);
}

function cacheEntryPath(cacheDir: string, key: string): string {
  return path.join(cacheDir, `${key}.jpg`);
}

export async function lookupCache(cacheDir: string, key: string): Promise<string | null> {
  const entry = cacheEntryPath(cacheDir, key);
  try {
    const s = await stat(entry);
    if (s.size > 1000) return entry;
  } catch {}
  return null;
}

// cacheDir is shared across concurrent wrapper invocations (unlike the
// per-run brain dir), so a bare copyFile could let a reader observe a
// partially written cache entry. Temp + rename keeps it atomic, same as
// the final output write in validator.ts.
export async function storeCache(cacheDir: string, key: string, sourcePath: string): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  const entry = cacheEntryPath(cacheDir, key);
  const tempPath = `${entry}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await copyFile(sourcePath, tempPath);
    await rename(tempPath, entry);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}
