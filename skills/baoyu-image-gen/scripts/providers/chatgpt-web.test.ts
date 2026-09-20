import assert from "node:assert/strict";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";

import type { CliArgs } from "../types.ts";
import { isRetryableGenerationError } from "../main.ts";
import {
  MAX_REFERENCE_IMAGES,
  assertInsideDir,
  buildOpencliArgs,
  buildOpencliError,
  buildPrompt,
  generateImage,
  getDefaultModel,
  getDefaultOutputExtension,
  parseSavedFile,
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
      const bytes = await generateImage("a face", "chatgpt-web", makeArgs({ referenceImages: ["/abs/ref.jpg"] }));
      assert.equal(Buffer.from(bytes).toString("base64"), PNG);
      const recorded = (await readFile(path.join(dir, "args.txt"), "utf8")).split("\n");
      assert.deepEqual(recorded.slice(0, 5), ["--profile", "main", "chatgpt", "image", "a face"]);
      assert.equal(recorded[recorded.indexOf("--image") + 1], "/abs/ref.jpg");
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
