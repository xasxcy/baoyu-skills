import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { CliArgs } from "../types.ts";
import {
  getVertexAccessToken,
  generateWithVertexNode,
  isVertexFailoverError,
  __clearVertexTokenCache,
} from "./google.ts";

function useEnv(t: TestContext, values: Record<string, string | null>): void {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous.entries()) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function makeArgs(overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompt: null,
    promptFiles: [],
    imagePath: null,
    provider: "vertex",
    model: null,
    aspectRatio: null,
    size: null,
    quality: null,
    imageSize: null,
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

function mockInlineImage(text: string): Response {
  return Response.json([
    {
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: Buffer.from(text).toString("base64") } }],
          },
        },
      ],
    },
  ]);
}

/** A fake `gcloud` that echoes the account it was invoked for. */
async function installFakeGcloud(t: TestContext): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-gcloud-"));
  const bin = path.join(dir, "gcloud");
  await fs.writeFile(bin, '#!/bin/sh\necho "tok:${CLOUDSDK_CORE_ACCOUNT:-none}"\n');
  await fs.chmod(bin, 0o755);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return bin;
}

// --- getVertexAccessToken --------------------------------------------

test("getVertexAccessToken injects CLOUDSDK_CORE_ACCOUNT and never mutates global env", async (t) => {
  __clearVertexTokenCache();
  const bin = await installFakeGcloud(t);
  useEnv(t, {
    GCLOUD_BIN: bin,
    VERTEX_BEARER_TOKEN: null,
    GOOGLE_ACCESS_TOKEN: null,
    CLOUDSDK_CORE_ACCOUNT: null,
  });

  assert.equal(getVertexAccessToken("alice@x.com"), "tok:alice@x.com");
  assert.equal(getVertexAccessToken("bob@x.com"), "tok:bob@x.com");
  assert.equal(process.env.CLOUDSDK_CORE_ACCOUNT, undefined); // global config untouched
});

test("getVertexAccessToken caches per account (no second gcloud call)", async (t) => {
  __clearVertexTokenCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-gcloud-"));
  const bin = path.join(dir, "gcloud");
  const marker = path.join(dir, "calls");
  await fs.writeFile(
    bin,
    `#!/bin/sh\necho x >> "${marker}"\necho "tok:\${CLOUDSDK_CORE_ACCOUNT:-none}"\n`,
  );
  await fs.chmod(bin, 0o755);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  useEnv(t, { GCLOUD_BIN: bin, VERTEX_BEARER_TOKEN: null, GOOGLE_ACCESS_TOKEN: null });

  getVertexAccessToken("carol@x.com");
  getVertexAccessToken("carol@x.com");
  const calls = (await fs.readFile(marker, "utf8")).trim().split("\n").length;
  assert.equal(calls, 1);
});

test("getVertexAccessToken: static token wins when no account is given", (t) => {
  __clearVertexTokenCache();
  useEnv(t, { VERTEX_BEARER_TOKEN: "static-123", GCLOUD_BIN: "/nonexistent/gcloud" });
  assert.equal(getVertexAccessToken(), "static-123");
});

test("getVertexAccessToken: accountless path is NOT cached (picks up active-account changes)", async (t) => {
  __clearVertexTokenCache();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fake-gcloud-"));
  const bin = path.join(dir, "gcloud");
  const marker = path.join(dir, "calls");
  await fs.writeFile(bin, `#!/bin/sh\necho x >> "${marker}"\necho "active-token"\n`);
  await fs.chmod(bin, 0o755);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  useEnv(t, { GCLOUD_BIN: bin, VERTEX_BEARER_TOKEN: null, GOOGLE_ACCESS_TOKEN: null });

  getVertexAccessToken();
  getVertexAccessToken();
  const calls = (await fs.readFile(marker, "utf8")).trim().split("\n").length;
  assert.equal(calls, 2); // one gcloud invocation per call, no caching
});

// --- generateWithVertexNode ----------------------------------------

test("generateWithVertexNode targets the node's project/location with its account token", async (t) => {
  __clearVertexTokenCache();
  const bin = await installFakeGcloud(t);
  useEnv(t, { GCLOUD_BIN: bin, VERTEX_BEARER_TOKEN: null, GOOGLE_ACCESS_TOKEN: null });

  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let seenUrl = "";
  let seenAuth = "";
  globalThis.fetch = async (input, init) => {
    seenUrl = String(input);
    seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return mockInlineImage("node-img");
  };

  const out = await generateWithVertexNode("prompt", "gemini-3.1-flash-image", makeArgs(), {
    project: "proj-x",
    location: "us-central1",
    account: "dave@x.com",
  });

  assert.equal(Buffer.from(out).toString("utf8"), "node-img");
  assert.match(seenUrl, /\/projects\/proj-x\/locations\/us-central1\//);
  assert.equal(seenAuth, "Bearer tok:dave@x.com");
});

test("generateWithVertexNode: account node + global static token throws without opt-in", async (t) => {
  __clearVertexTokenCache();
  useEnv(t, {
    VERTEX_BEARER_TOKEN: "static-abc",
    VERTEX_POOL_ALLOW_STATIC_TOKEN: null,
  });
  await assert.rejects(
    generateWithVertexNode("p", "m", makeArgs(), {
      project: "p1",
      location: "global",
      account: "e@x.com",
    }),
    /VERTEX_POOL_ALLOW_STATIC_TOKEN=1/,
  );
});

test("generateWithVertexNode: opt-in lets the static token authorize an account node", async (t) => {
  __clearVertexTokenCache();
  useEnv(t, {
    VERTEX_BEARER_TOKEN: "static-abc",
    VERTEX_POOL_ALLOW_STATIC_TOKEN: "1",
    GCLOUD_BIN: "/nonexistent/gcloud",
  });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let seenAuth = "";
  globalThis.fetch = async (_input, init) => {
    seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
    return mockInlineImage("img");
  };

  await generateWithVertexNode("p", "m", makeArgs(), {
    project: "p1",
    location: "global",
    account: "f@x.com",
  });
  assert.equal(seenAuth, "Bearer static-abc");
});

test("generateWithVertexNode: propagates non-2xx as retryable-classified Vertex error", async (t) => {
  __clearVertexTokenCache();
  useEnv(t, { VERTEX_BEARER_TOKEN: "static-xyz", VERTEX_POOL_ALLOW_STATIC_TOKEN: null });
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    new Response("RESOURCE_EXHAUSTED", { status: 429 });

  await assert.rejects(
    generateWithVertexNode("p", "m", makeArgs(), { project: "p1", location: "global" }),
    (err: Error) => {
      assert.match(err.message, /Vertex AI error \(429\)/);
      assert.equal(isVertexFailoverError(err), true);
      return true;
    },
  );
});

// --- isVertexFailoverError -----------------------------------------

test("isVertexFailoverError classifies transient vs permanent", () => {
  for (const s of [429, 500, 502, 503, 504]) {
    assert.equal(isVertexFailoverError(new Error(`Vertex AI error (${s}): x`)), true, `${s}`);
  }
  for (const s of [400, 401, 403, 404]) {
    assert.equal(isVertexFailoverError(new Error(`Vertex AI error (${s}): x`)), false, `${s}`);
  }
  assert.equal(isVertexFailoverError(new Error("fetch failed")), true);
  assert.equal(isVertexFailoverError(new Error("connect ECONNRESET 1.2.3.4:443")), true);
  assert.equal(isVertexFailoverError(new Error("getaddrinfo ENOTFOUND host")), true);
  assert.equal(isVertexFailoverError(new Error("No image in Vertex AI response")), false);
  assert.equal(isVertexFailoverError(new Error("boom")), false);
});
