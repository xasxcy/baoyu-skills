import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";

import type { CliArgs } from "../types.ts";
import {
  buildRequestBody,
  extractImageFromResponse,
  generateImage,
  getDefaultModel,
  resolveImageSize,
  validateArgs,
} from "./siliconflow.ts";

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null, promptFiles: [], imagePath: null, provider: "siliconflow", model: null,
    aspectRatio: null, size: null, quality: "2k", imageSize: null, imageApiDialect: null,
    responseFormat: null, referenceImages: [], n: 1, batchFile: null, jobs: null,
    json: false, help: false, ...overrides,
  };
}

function useEnv(t: TestContext, values: Record<string, string | null>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value == null) delete process.env[key]; else process.env[key] = value;
    }
  });
}

async function makeTempImage(t: TestContext, name: string, bytes?: Uint8Array): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "siliconflow-test-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, bytes || Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7m0AAAAASUVORK5CYII=", "base64"));
  return filePath;
}

test("SiliconFlow defaults and size mapping use the documented Qwen settings", (t) => {
  useEnv(t, { SILICONFLOW_IMAGE_MODEL: null });
  assert.equal(getDefaultModel(), "Qwen/Qwen-Image");
  assert.equal(resolveImageSize(makeArgs({ aspectRatio: "16:9" })), "1664x928");
  assert.equal(resolveImageSize(makeArgs({ size: "1024*768" })), "1024x768");
});

test("SiliconFlow validates the three supported Qwen model/ref combinations", () => {
  // A text-family model with stray reference images is tolerated (refs are dropped
  // downstream) rather than rejected — see the FLUX/SD/Kolors routing in getModelFamily.
  assert.doesNotThrow(() => validateArgs("Qwen/Qwen-Image", makeArgs({ referenceImages: ["a.png"] })));
  assert.throws(() => validateArgs("Qwen/Qwen-Image-Edit", makeArgs()), /requires at least one/);
  assert.throws(() => validateArgs("Qwen/Qwen-Image-Edit", makeArgs({ referenceImages: ["a.png", "b.png"] })), /exactly one/);
  assert.doesNotThrow(() => validateArgs("Qwen/Qwen-Image-Edit-2509", makeArgs({ referenceImages: ["a.png", "b.png", "c.png"] })));
  assert.throws(() => validateArgs("Qwen/Other", makeArgs()), /Unsupported SiliconFlow model/);
});

test("SiliconFlow request bodies use lowercase image_size and edit image fields", async (t) => {
  const one = await makeTempImage(t, "one.png");
  const two = await makeTempImage(t, "two.png");
  const three = await makeTempImage(t, "three.jpg", Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));

  const text = await buildRequestBody("cat", "Qwen/Qwen-Image", makeArgs({ aspectRatio: "16:9" }));
  assert.equal(text.image_size, "1664x928");
  assert.ok(!("image" in text));

  const edit = await buildRequestBody("blue", "Qwen/Qwen-Image-Edit", makeArgs({ referenceImages: [one] }));
  assert.match(String(edit.image), /^data:image\/png;base64,/);
  assert.ok(!("image_size" in edit));

  const multi = await buildRequestBody("blue", "Qwen/Qwen-Image-Edit-2509", makeArgs({ referenceImages: [one, two, three] }));
  assert.match(String(multi.image), /^data:image\/png;base64,/);
  assert.match(String(multi.image2), /^data:image\/png;base64,/);
  assert.match(String(multi.image3), /^data:image\/jpeg;base64,/);
});

test("SiliconFlow response extraction prefers images then falls back to data and fails clearly", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const seen: string[] = [];
  globalThis.fetch = (async (input: string) => {
    seen.push(input);
    return new Response(Uint8Array.from([1, 2, 3]));
  }) as typeof fetch;
  assert.deepEqual(await extractImageFromResponse({ images: [{ url: "https://image-first" }], data: [{ url: "https://fallback" }] }), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(seen, ["https://image-first"]);
  await assert.rejects(() => extractImageFromResponse({}), /No image URL/);
});

test("SiliconFlow generateImage posts then immediately downloads the temporary URL", async (t) => {
  useEnv(t, { SILICONFLOW_API_KEY: "test-key", SILICONFLOW_BASE_URL: null });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    if (calls.length === 1) return Response.json({ images: [{ url: "https://temporary.example/image" }] });
    return new Response(Uint8Array.from([7, 8, 9]));
  }) as typeof fetch;
  assert.deepEqual(await generateImage("cat", "Qwen/Qwen-Image", makeArgs()), Uint8Array.from([7, 8, 9]));
  assert.equal(calls[0]!.input, "https://api.siliconflow.cn/v1/images/generations");
  assert.match(String(calls[0]!.init?.headers instanceof Headers ? calls[0]!.init?.headers.get("Authorization") : (calls[0]!.init?.headers as Record<string, string>).Authorization), /Bearer test-key/);
  assert.equal(calls[1]!.input, "https://temporary.example/image");
});
