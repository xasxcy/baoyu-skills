import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";

import type { CliArgs } from "../types.ts";
import { isRetryableGenerationError } from "../main.ts";
import {
  MAX_REFERENCE_IMAGES,
  type ImageConverter,
  assertInsideDir,
  buildOpencliArgs,
  buildOpencliError,
  buildPrompt,
  fsHooks,
  generateImage,
  getDefaultModel,
  getDefaultOutputExtension,
  normalizeReferences,
  parseSavedFile,
  parseSipsDimensions,
  runOpencli,
  validateArgs,
} from "./chatgpt-web.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: "chatgpt-web",
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

test("chatgpt-web defaults to a label model and PNG output", () => {
  assert.equal(getDefaultModel(), "chatgpt-web");
  assert.equal(getDefaultOutputExtension(), ".png");
});

test("chatgpt-web validateArgs accepts defaults and rejects unsupported options", () => {
  assert.doesNotThrow(() => validateArgs("chatgpt-web", makeArgs()));
  assert.throws(() => validateArgs("gpt-image-2", makeArgs()), /Invalid model for chatgpt-web/);
  assert.throws(() => validateArgs("chatgpt-web", makeArgs({ n: 2 })), /supports only n=1/);
  assert.throws(() => validateArgs("chatgpt-web", makeArgs({ size: "1024x1024" })), /does not support --size/);
  assert.throws(
    () => validateArgs("chatgpt-web", makeArgs({ imageApiDialect: "ratio-metadata" })),
    /Invalid imageApiDialect/,
  );
});

test("chatgpt-web validateArgs enforces the reference image cap", () => {
  const ok = Array.from({ length: MAX_REFERENCE_IMAGES }, (_, i) => `/tmp/r${i}.jpg`);
  assert.doesNotThrow(() => validateArgs("chatgpt-web", makeArgs({ referenceImages: ok })));
  assert.throws(
    () => validateArgs("chatgpt-web", makeArgs({ referenceImages: [...ok, "/tmp/extra.jpg"] })),
    /at most 5 reference images/,
  );
});

test("chatgpt-web buildPrompt adds an aspect hint and guards a leading dash", () => {
  assert.equal(buildPrompt("a face", makeArgs()), "a face");
  assert.equal(buildPrompt("a face", makeArgs({ aspectRatio: "4:5" })), "a face\n\nAspect ratio: 4:5.");
  assert.equal(buildPrompt("- item", makeArgs()), "\n- item");
});

test("chatgpt-web buildOpencliArgs puts --profile before the subcommand and joins refs", () => {
  const cli = buildOpencliArgs("hello", makeArgs({ referenceImages: ["a.jpg", "/abs/b.jpg"] }), "/out", {
    profile: "main",
    timeoutMs: 240_000,
  });
  assert.deepEqual(cli.slice(0, 4), ["--profile", "main", "chatgpt", "image"]);
  assert.equal(cli[4], "hello");
  const imageIdx = cli.indexOf("--image");
  assert.equal(cli[imageIdx + 1], `${path.resolve("a.jpg")},/abs/b.jpg`);
  assert.deepEqual(cli.slice(cli.indexOf("--op")), ["--op", "/out", "--timeout", "240", "-f", "json"]);

  const bare = buildOpencliArgs("hello", makeArgs(), "/out", { timeoutMs: 1500 });
  assert.equal(bare.includes("--profile"), false);
  assert.equal(bare.includes("--image"), false);
  assert.equal(bare[bare.indexOf("--timeout") + 1], "2");
});

test("chatgpt-web parseSavedFile strips the emoji prefix and tolerates surrounding noise", () => {
  const payload = JSON.stringify([{ status: "✅ saved", file: "📁 /tmp/x/chatgpt_1.png", link: "🔗 https://chatgpt.com/c/1" }]);
  assert.equal(parseSavedFile(payload), "/tmp/x/chatgpt_1.png");
  assert.equal(parseSavedFile(`Update available\n${payload}\n`), "/tmp/x/chatgpt_1.png");
  const home = parseSavedFile(JSON.stringify([{ status: "✅ saved", file: "📁 ~/Pictures/a.png" }]));
  assert.equal(home, path.join(os.homedir(), "Pictures/a.png"));
});

test("chatgpt-web parseSavedFile rejects skip-download rows and garbage", () => {
  assert.throws(() => parseSavedFile(JSON.stringify([{ status: "🎨 generated", file: "📁 -" }])), /no saved image row/);
  assert.throws(() => parseSavedFile("not json"), /no saved image row/);
  assert.throws(() => parseSavedFile(""), /no saved image row/);
});

test("chatgpt-web buildOpencliError extracts code and message and is never retryable", () => {
  const busy = buildOpencliError(
    "",
    "ok: false\nerror:\n  code: SESSION_BUSY\n  message: 'Session \"site:chatgpt\" is busy'\n",
    75,
  );
  assert.match(busy.message, /^Invalid chatgpt-web result \(exit 75, SESSION_BUSY\)/);
  assert.match(busy.message, /wait for it or stop it/);
  assert.equal(isRetryableGenerationError(busy), false);

  const dropped = buildOpencliError(
    "ok: false\nerror:\n  code: UNKNOWN\n  message: Browser connection dropped after the navigate command was dispatched; it may have completed.\n",
    "",
    1,
  );
  assert.match(dropped.message, /UNKNOWN/);
  assert.equal(isRetryableGenerationError(dropped), false);
});

async function withFakeOpencli(
  script: string,
  run: (ctx: { bin: string; dir: string }) => Promise<void>,
  shebang = "#!/bin/bash",
): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-test-"));
  const bin = path.join(dir, "fake-opencli.sh");
  await writeFile(bin, `${shebang}\n${script}\n`, "utf8");
  await chmod(bin, 0o755);
  const prevBin = process.env.BAOYU_CHATGPT_WEB_BIN;
  const prevProfile = process.env.BAOYU_CHATGPT_WEB_PROFILE;
  process.env.BAOYU_CHATGPT_WEB_BIN = bin;
  process.env.BAOYU_CHATGPT_WEB_PROFILE = "main";
  try {
    await run({ bin, dir });
  } finally {
    if (prevBin === undefined) delete process.env.BAOYU_CHATGPT_WEB_BIN;
    else process.env.BAOYU_CHATGPT_WEB_BIN = prevBin;
    if (prevProfile === undefined) delete process.env.BAOYU_CHATGPT_WEB_PROFILE;
    else process.env.BAOYU_CHATGPT_WEB_PROFILE = prevProfile;
    await rm(dir, { recursive: true, force: true });
  }
}

const PNG = "iVBORw0KGgo="; // base64 of the 8-byte PNG signature
const PIXEL_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function writePixelPng(dir: string, name = "ref.png"): Promise<string> {
  const file = path.join(dir, name);
  await writeFile(file, Buffer.from(PIXEL_PNG_B64, "base64"));
  return file;
}

function hasSips(): Promise<boolean> {
  return new Promise((resolve) => {
    import("node:child_process").then(({ execFile }) => execFile("sips", ["--version"], (err) => resolve(!err)));
  });
}

test("chatgpt-web generateImage returns the saved bytes and forwards profile, refs and prompt", async () => {
  await withFakeOpencli(
    `
ARGS_FILE="$(dirname "$0")/args.txt"
printf '%s\\n' "$@" > "$ARGS_FILE"
OUT=""
while [ $# -gt 0 ]; do if [ "$1" = "--op" ]; then OUT="$2"; fi; shift; done
echo "${PNG}" | base64 -d > "\${OUT}/chatgpt_1.png"
echo "[{\\"status\\":\\"✅ saved\\",\\"file\\":\\"📁 \${OUT}/chatgpt_1.png\\",\\"link\\":\\"🔗 https://chatgpt.com/c/1\\"}]"
`,
    async ({ dir }) => {
      const ref = await writePixelPng(dir);
      const before = await readFile(ref);
      const bytes = await generateImage("a face", "chatgpt-web", makeArgs({ referenceImages: [ref] }));
      assert.equal(Buffer.from(bytes).toString("base64"), PNG);
      const recorded = (await readFile(path.join(dir, "args.txt"), "utf8")).split("\n");
      assert.deepEqual(recorded.slice(0, 5), ["--profile", "main", "chatgpt", "image", "a face"]);
      const sent = recorded[recorded.indexOf("--image") + 1]!;
      if (await hasSips()) {
        assert.match(sent, /baoyu-image-gen-chatgpt-web\/ref-[^/]+\/ref-1\.jpg$/, "refs are re-encoded into the temp ref dir");
      } else {
        assert.equal(sent, ref, "without a converter the original is passed through");
      }
      assert.deepEqual(await readFile(ref), before, "the caller's original must never be modified");
    },
  );
});

test("chatgpt-web generateImage surfaces opencli failures and cleans its temp dir", async () => {
  const root = path.join(os.tmpdir(), "baoyu-image-gen-chatgpt-web");
  const before = new Set(await readdir(root).catch(() => [] as string[]));
  await withFakeOpencli(
    `printf 'ok: false\\nerror:\\n  code: COMMAND_EXEC\\n  message: upload failed\\n'\nexit 1`,
    async () => {
      await assert.rejects(
        () => generateImage("a face", "chatgpt-web", makeArgs()),
        /Invalid chatgpt-web result \(exit 1, COMMAND_EXEC\): upload failed/,
      );
    },
  );
  const after = (await readdir(root).catch(() => [] as string[])).filter((name) => !before.has(name));
  assert.deepEqual(after, []);
});

test("chatgpt-web generateImage reports a missing opencli binary as a setup error", async () => {
  const prev = process.env.BAOYU_CHATGPT_WEB_BIN;
  process.env.BAOYU_CHATGPT_WEB_BIN = "/nonexistent/opencli-bin";
  try {
    await assert.rejects(() => generateImage("a face", "chatgpt-web", makeArgs()), /Invalid chatgpt-web setup: .* not found/);
  } finally {
    if (prev === undefined) delete process.env.BAOYU_CHATGPT_WEB_BIN;
    else process.env.BAOYU_CHATGPT_WEB_BIN = prev;
  }
});

test("chatgpt-web generateImage fails when opencli exits 0 without a saved row", async () => {
  await withFakeOpencli(`echo '[{"status":"🎨 generated","file":"📁 -","link":"🔗 x"}]'`, async () => {
    await assert.rejects(() => generateImage("a face", "chatgpt-web", makeArgs()), /no saved image row/);
  });
});

test("chatgpt-web validateArgs enforces n === 1, including batch-path zero and negatives", () => {
  assert.throws(() => validateArgs("chatgpt-web", makeArgs({ n: 0 })), /only n=1.*got 0/);
  assert.throws(() => validateArgs("chatgpt-web", makeArgs({ n: -1 })), /only n=1.*got -1/);
});

test("chatgpt-web assertInsideDir accepts children and rejects escapes", () => {
  assert.equal(assertInsideDir("/tmp/o/a.png", "/tmp/o"), "/tmp/o/a.png");
  assert.throws(() => assertInsideDir("/etc/hosts", "/tmp/o"), /outside this call's output dir/);
  assert.throws(() => assertInsideDir("/tmp/o/../secret.png", "/tmp/o"), /outside this call's output dir/);
  assert.throws(() => assertInsideDir("/tmp/o", "/tmp/o"), /outside this call's output dir/);
  assert.throws(() => assertInsideDir("/tmp/other/a.png", "/tmp/o"), /outside/);
});

test("chatgpt-web generateImage refuses a reported file outside the output dir", async () => {
  await withFakeOpencli(
    `echo '[{"status":"✅ saved","file":"📁 /etc/hosts","link":"🔗 x"}]'`,
    async () => {
      const err = await generateImage("a face", "chatgpt-web", makeArgs()).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err);
      assert.match(err.message, /outside this call's output dir/);
      assert.equal(isRetryableGenerationError(err), false);
    },
  );
});

test("chatgpt-web generateImage wraps a missing output file as a non-retryable Invalid error", async () => {
  await withFakeOpencli(
    `
const args = process.argv.slice(2);
const out = args[args.indexOf("--op") + 1];
console.log(JSON.stringify([{ status: "✅ saved", file: "📁 " + out + "/gone.png", link: "🔗 x" }]));
`,
    async () => {
      const err = await generateImage("a face", "chatgpt-web", makeArgs()).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err);
      assert.match(err.message, /^Invalid chatgpt-web result: could not read the generated image/);
      assert.equal(isRetryableGenerationError(err), false);
    },
    "#!/usr/bin/env node",
  );
});

test("chatgpt-web runOpencli escalates to SIGKILL when the child ignores SIGTERM", async () => {
  await withFakeOpencli(
    `process.on("SIGTERM", () => {});\nsetInterval(() => {}, 1000);\nconsole.log("ready");`,
    async ({ bin }) => {
      const started = Date.now();
      const err = await runOpencli(bin, [], 1000, 1000, 300).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err);
      assert.match(err.message, /^Invalid chatgpt-web result: opencli ignored SIGTERM/);
      assert.equal(isRetryableGenerationError(err), false);
      assert.ok(Date.now() - started < 3000, "must settle shortly after the SIGKILL escalation");
    },
    "#!/usr/bin/env node",
  );
});

test("chatgpt-web runOpencli reports a plain timeout when SIGTERM is honored", async () => {
  await withFakeOpencli(
    `setInterval(() => {}, 1000);`,
    async ({ bin }) => {
      const err = await runOpencli(bin, [], 1000, 1000, 5000).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err);
      assert.match(err.message, /^Invalid chatgpt-web result: opencli did not exit within/);
    },
    "#!/usr/bin/env node",
  );
});

// Smallest buffer that passes the structural check: SOI ... EOI.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02, 0xff, 0xd9]);

const okConverter = (name: string, seen: string[] = []): ImageConverter => ({
  name,
  run: async (input, output) => {
    seen.push(`${name}:${path.basename(input)}->${path.basename(output)}`);
    await writeFile(output, FAKE_JPEG);
  },
});
const missingConverter = (name: string): ImageConverter => ({
  name,
  run: async () => {
    throw Object.assign(new Error(`spawn ${name} ENOENT`), { code: "ENOENT" });
  },
});

test("chatgpt-web normalizeReferences re-encodes every ref in order without touching originals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    const seen: string[] = [];
    const out = await normalizeReferences(["/x/a.png", "/x/b.jpg"], dir, [okConverter("c1", seen)]);
    assert.deepEqual(out, [path.join(dir, "ref-1.jpg"), path.join(dir, "ref-2.jpg")]);
    assert.deepEqual(seen, ["c1:a.png->ref-1.jpg", "c1:b.jpg->ref-2.jpg"]);
    assert.deepEqual(await normalizeReferences([], dir, [okConverter("c1")]), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web normalizeReferences shrinks all refs together until the total fits the budget", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-budget-"));
  try {
    const tiersSeen: number[] = [];
    // Each ref is 300 bytes at maxEdge 1000, 100 bytes at maxEdge 500.
    const converter: ImageConverter = {
      name: "sized",
      run: async (_input, output, tier) => {
        tiersSeen.push(tier.maxEdge);
        await writeFile(output, Buffer.concat([FAKE_JPEG.subarray(0, 6), Buffer.alloc(tier.maxEdge === 1000 ? 292 : 92), FAKE_JPEG.subarray(6)]));
      },
    };
    const tiers = [{ maxEdge: 1000, quality: 85 }, { maxEdge: 500, quality: 70 }];
    const out = await normalizeReferences(["/x/a.png", "/x/b.png", "/x/c.png"], dir, [converter], tiers, 500);
    assert.equal(out.length, 3);
    assert.deepEqual(tiersSeen, [1000, 1000, 1000, 500, 500, 500]);
    assert.ok((await stat(out[0]!)).size < 200);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web normalizeReferences keeps the first tier when the total already fits", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cw-budget-"));
  try {
    const seen: string[] = [];
    await normalizeReferences(["/x/a.png"], dir, [okConverter("c1", seen)], [{ maxEdge: 1000, quality: 85 }, { maxEdge: 500, quality: 70 }], 500);
    assert.equal(seen.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web normalizeReferences falls through a missing converter to the next one", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    const seen: string[] = [];
    const out = await normalizeReferences(["/x/a.png"], dir, [missingConverter("sips"), okConverter("magick", seen)]);
    assert.deepEqual(out, [path.join(dir, "ref-1.jpg")]);
    assert.deepEqual(seen, ["magick:a.png->ref-1.jpg"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web normalizeReferences passes originals through when no converter is installed", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    const out = await normalizeReferences(["/x/a.png"], dir, [missingConverter("sips"), missingConverter("magick")]);
    assert.deepEqual(out, [path.resolve("/x/a.png")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web normalizeReferences reports an unreadable image as a non-retryable Invalid error", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  const failing: ImageConverter = {
    name: "sips",
    run: async () => {
      throw Object.assign(new Error("exit 1"), { stderr: "Error: not a valid image\nmore" });
    },
  };
  try {
    const err = await normalizeReferences(["/x/bad.png"], dir, [failing]).then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(err);
    assert.match(err.message, /^Invalid chatgpt-web reference image: sips could not re-encode .*bad\.png \(Error: not a valid image\)\./);
    assert.equal(isRetryableGenerationError(err), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web real sips converter produces a JPEG and leaves the source untouched", async (t) => {
  if (!(await hasSips())) return t.skip("sips not available");
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    const src = await writePixelPng(dir, "src.png");
    const before = await readFile(src);
    const [out] = await normalizeReferences([src], dir);
    const bytes = await readFile(out!);
    assert.equal(bytes[0], 0xff);
    assert.equal(bytes[1], 0xd8, "JPEG SOI marker");
    assert.deepEqual(await readFile(src), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web generateImage removes both temp dirs (out and ref) after a call", async () => {
  const root = path.join(os.tmpdir(), "baoyu-image-gen-chatgpt-web");
  const before = new Set(await readdir(root).catch(() => [] as string[]));
  await withFakeOpencli(`printf 'ok: false\\nerror:\\n  code: X\\n  message: boom\\n'\nexit 1`, async ({ dir }) => {
    const ref = await writePixelPng(dir);
    await assert.rejects(() => generateImage("a face", "chatgpt-web", makeArgs({ referenceImages: [ref] })), /Invalid chatgpt-web result/);
  });
  const leaked = (await readdir(root).catch(() => [] as string[])).filter((name) => !before.has(name));
  assert.deepEqual(leaked, []);
});

test("chatgpt-web normalizeReferences rejects a converter that exits 0 without producing a JPEG", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  const silent: ImageConverter = { name: "sips", run: async () => {} };
  const notJpeg: ImageConverter = { name: "sips", run: async (_in, out) => writeFile(out, "PNGDATA-PNGDATA") };
  const truncated: ImageConverter = { name: "sips", run: async (_in, out) => writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0])) };
  const noEoi: ImageConverter = { name: "sips", run: async (_in, out) => writeFile(out, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])) };
  try {
    for (const converter of [silent, notJpeg, truncated, noEoi]) {
      const err = await normalizeReferences(["/x/a.png"], dir, [converter]).then(
        () => null,
        (e: Error) => e,
      );
      assert.ok(err, "must not report success");
      assert.match(err.message, /^Invalid chatgpt-web reference image: sips produced no usable JPEG/);
      assert.equal(isRetryableGenerationError(err), false);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web real sips: a nonexistent input (spaces, quotes, leading dash) is rejected, not reported as converted", async (t) => {
  if (!(await hasSips())) return t.skip("sips not available");
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    for (const name of ["/definitely-missing/my \"ref\" file.png", "-leading-dash.png"]) {
      await assert.rejects(
        () => normalizeReferences([name], dir),
        /^Error: Invalid chatgpt-web reference image: sips (produced no usable JPEG|could not re-encode)/,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web generateImage cleans outDir when the ref temp dir cannot be created", async () => {
  const root = path.join(os.tmpdir(), "baoyu-image-gen-chatgpt-web");
  await mkdir(root, { recursive: true });
  const before = new Set(await readdir(root));
  const original = fsHooks.mkdtemp;
  let calls = 0;
  fsHooks.mkdtemp = (async (prefix: string) => {
    calls += 1;
    if (calls === 2) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    return original(prefix);
  }) as typeof original;
  try {
    await assert.rejects(() => generateImage("a face", "chatgpt-web", makeArgs()), /ENOSPC/);
  } finally {
    fsHooks.mkdtemp = original;
  }
  assert.equal(calls, 2, "outDir was created, then the ref dir allocation failed");
  const leaked = (await readdir(root)).filter((name) => !before.has(name));
  assert.deepEqual(leaked, [], "outDir must not leak when refDir allocation fails");
});

test("chatgpt-web real sips never enlarges a small reference", async (t) => {
  if (!(await hasSips())) return t.skip("sips not available");
  const dir = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    const src = await writePixelPng(dir, "tiny.png");
    const [out] = await normalizeReferences([src], dir);
    const dims = await new Promise<string>((resolve, reject) =>
      import("node:child_process").then(({ execFile }) =>
        execFile("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out!], (err, stdout) => (err ? reject(err) : resolve(stdout))),
      ),
    );
    assert.match(dims, /pixelWidth:\s*1\b/);
    assert.match(dims, /pixelHeight:\s*1\b/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("chatgpt-web parseSipsDimensions ignores dimensions forged through the file path", () => {
  const forged = [
    "/tmp/pixelWidth: 999999\n  pixelHeight: 999999/tiny.png",
    "  pixelWidth: 1",
    "  pixelHeight: 1",
  ].join("\n");
  assert.deepEqual(parseSipsDimensions(forged), { width: 1, height: 1 });

  const pathOnly = "/tmp/pixelWidth: 999999 pixelHeight: 999999/tiny.png\n  pixelWidth: 4\n  pixelHeight: 3\n";
  assert.deepEqual(parseSipsDimensions(pathOnly), { width: 4, height: 3 });

  assert.equal(parseSipsDimensions("/tmp/a.png\n"), null, "missing metadata is unknown, not zero");
  assert.equal(parseSipsDimensions("/tmp/a.png\n  pixelWidth: 5\n"), null, "one axis is not enough");
});

test("chatgpt-web real sips does not enlarge a small image whose directory name imitates sips metadata", async (t) => {
  if (!(await hasSips())) return t.skip("sips not available");
  const base = await mkdtemp(path.join(os.tmpdir(), "chatgpt-web-norm-"));
  try {
    const evil = path.join(base, "pixelWidth: 999999 pixelHeight: 999999");
    await mkdir(evil, { recursive: true });
    const src = await writePixelPng(evil, "tiny.png");
    const [out] = await normalizeReferences([src], base);
    const dims = await new Promise<string>((resolve, reject) =>
      import("node:child_process").then(({ execFile }) =>
        execFile("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out!], (err, stdout) => (err ? reject(err) : resolve(stdout))),
      ),
    );
    assert.match(dims, /pixelWidth:\s*1\b/);
    assert.match(dims, /pixelHeight:\s*1\b/);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
