import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import type { CliArgs } from "../types";
import type { VertexExecContext } from "./vertex-pool";

const GOOGLE_MULTIMODAL_MODELS = [
  "gemini-3-pro-image",
  "gemini-3.1-flash-image",
  "gemini-3-pro-image-preview",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-image-preview",
];
const GOOGLE_IMAGEN_MODELS = [
  "imagen-3.0-generate-002",
  "imagen-3.0-generate-001",
];

export function getDefaultModel(): string {
  return process.env.GOOGLE_IMAGE_MODEL || "gemini-3-pro-image";
}

export function normalizeGoogleModelId(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

export function isGoogleMultimodal(model: string): boolean {
  const normalized = normalizeGoogleModelId(model);
  return GOOGLE_MULTIMODAL_MODELS.some((m) => normalized.includes(m));
}

export function isGoogleImagen(model: string): boolean {
  const normalized = normalizeGoogleModelId(model);
  return GOOGLE_IMAGEN_MODELS.some((m) => normalized.includes(m));
}

function getGoogleApiKey(): string | null {
  return process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || null;
}

export function getGoogleImageSize(args: CliArgs): "1K" | "2K" | "4K" {
  if (args.imageSize) return args.imageSize as "1K" | "2K" | "4K";
  return args.quality === "2k" ? "2K" : "1K";
}

function getGoogleBaseUrl(): string {
  const base =
    process.env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com";
  return base.replace(/\/+$/g, "");
}

export function buildGoogleUrl(pathname: string): string {
  const base = getGoogleBaseUrl();
  const cleanedPath = pathname.replace(/^\/+/g, "");
  if (base.endsWith("/v1beta")) return `${base}/${cleanedPath}`;
  return `${base}/v1beta/${cleanedPath}`;
}

function toModelPath(model: string): string {
  const modelId = normalizeGoogleModelId(model);
  return `models/${modelId}`;
}

function getHttpProxy(): string | null {
  return (
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.ALL_PROXY ||
    null
  );
}

async function postGoogleJsonViaCurl<T>(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<T> {
  const proxy = getHttpProxy();
  const bodyStr = JSON.stringify(body);
  const args = [
    "-s",
    "--connect-timeout",
    "30",
    "--max-time",
    "300",
    ...(proxy ? ["-x", proxy] : []),
    url,
    "-H",
    "Content-Type: application/json",
    "-H",
    `x-goog-api-key: ${apiKey}`,
    "-d",
    "@-",
  ];

  let result = "";
  try {
    result = execFileSync("curl", args, {
      input: bodyStr,
      encoding: "utf8",
      maxBuffer: 100 * 1024 * 1024,
      timeout: 310000,
    });
  } catch (error) {
    const e = error as { message?: string; stderr?: string | Buffer };
    const stderrText =
      typeof e.stderr === "string"
        ? e.stderr
        : e.stderr
          ? e.stderr.toString("utf8")
          : "";
    const details = stderrText.trim() || e.message || "curl request failed";
    throw new Error(`Google API request failed via curl: ${details}`);
  }

  const parsed = JSON.parse(result) as any;
  if (parsed.error) {
    throw new Error(
      `Google API error (${parsed.error.code}): ${parsed.error.message}`,
    );
  }
  return parsed as T;
}

async function postGoogleJsonViaFetch<T>(
  url: string,
  apiKey: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API error (${res.status}): ${err}`);
  }

  return (await res.json()) as T;
}

async function postGoogleJson<T>(pathname: string, body: unknown): Promise<T> {
  const apiKey = getGoogleApiKey();
  if (!apiKey) throw new Error("GOOGLE_API_KEY or GEMINI_API_KEY is required");

  const url = buildGoogleUrl(pathname);
  const proxy = getHttpProxy();

  // When an HTTP proxy is detected, use curl instead of fetch.
  // Bun's fetch has a known issue where long-lived connections through
  // HTTP proxies get their sockets closed unexpectedly, causing image
  // generation requests to fail with "socket connection was closed
  // unexpectedly". Using curl as the HTTP client works around this.
  if (proxy) {
    return postGoogleJsonViaCurl<T>(url, apiKey, body);
  }

  return postGoogleJsonViaFetch<T>(url, apiKey, body);
}

export function buildPromptWithAspect(
  prompt: string,
  ar: string | null,
  quality: CliArgs["quality"],
): string {
  let result = prompt;
  if (ar) {
    result += ` Aspect ratio: ${ar}.`;
  }
  if (quality === "2k") {
    result += " High resolution 2048px.";
  }
  return result;
}

export function addAspectRatioToPrompt(prompt: string, ar: string | null): string {
  if (!ar) return prompt;
  return `${prompt} Aspect ratio: ${ar}.`;
}

async function readImageAsBase64(
  p: string,
): Promise<{ data: string; mimeType: string }> {
  const buf = await readFile(p);
  const ext = path.extname(p).toLowerCase();
  let mimeType = "image/png";
  if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
  else if (ext === ".gif") mimeType = "image/gif";
  else if (ext === ".webp") mimeType = "image/webp";
  return { data: buf.toString("base64"), mimeType };
}

export function extractInlineImageData(response: {
  candidates?: Array<{
    content?: { parts?: Array<{ inlineData?: { data?: string } }> };
  }>;
}): string | null {
  for (const candidate of response.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      const data = part.inlineData?.data;
      if (typeof data === "string" && data.length > 0) return data;
    }
  }
  return null;
}

export function extractPredictedImageData(response: {
  predictions?: Array<any>;
  generatedImages?: Array<any>;
}): string | null {
  const candidates = [
    ...(response.predictions || []),
    ...(response.generatedImages || []),
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (typeof candidate.imageBytes === "string") return candidate.imageBytes;
    if (typeof candidate.bytesBase64Encoded === "string")
      return candidate.bytesBase64Encoded;
    if (typeof candidate.data === "string") return candidate.data;
    const image = candidate.image;
    if (image && typeof image === "object") {
      if (typeof image.imageBytes === "string") return image.imageBytes;
      if (typeof image.bytesBase64Encoded === "string")
        return image.bytesBase64Encoded;
      if (typeof image.data === "string") return image.data;
    }
  }
  return null;
}

async function generateWithGemini(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const promptWithAspect = addAspectRatioToPrompt(prompt, args.aspectRatio);
  const parts: Array<{
    text?: string;
    inlineData?: { data: string; mimeType: string };
  }> = [];
  for (const refPath of args.referenceImages) {
    const { data, mimeType } = await readImageAsBase64(refPath);
    parts.push({ inlineData: { data, mimeType } });
  }
  parts.push({ text: promptWithAspect });

  const imageConfig: { imageSize: "1K" | "2K" | "4K"; aspectRatio?: string } = {
    imageSize: getGoogleImageSize(args),
  };
  if (args.aspectRatio) {
    imageConfig.aspectRatio = args.aspectRatio;
  }

  console.log("Generating image with Gemini...", imageConfig);
  const response = await postGoogleJson<{
    candidates?: Array<{
      content?: { parts?: Array<{ inlineData?: { data?: string } }> };
    }>;
  }>(`${toModelPath(model)}:generateContent`, {
    contents: [
      {
        role: "user",
        parts,
      },
    ],
    generationConfig: {
      responseModalities: ["IMAGE"],
      imageConfig,
    },
  });
  console.log("Generation completed.");

  const imageData = extractInlineImageData(response);
  if (imageData) return Uint8Array.from(Buffer.from(imageData, "base64"));

  throw new Error("No image in response");
}

async function generateWithImagen(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  const fullPrompt = buildPromptWithAspect(
    prompt,
    args.aspectRatio,
    args.quality,
  );
  const imageSize = getGoogleImageSize(args);
  if (imageSize === "4K") {
    console.error(
      "Warning: Imagen models do not support 4K imageSize, using 2K instead.",
    );
  }

  const parameters: Record<string, unknown> = {
    sampleCount: args.n,
  };
  if (args.aspectRatio) {
    parameters.aspectRatio = args.aspectRatio;
  }
  if (imageSize === "1K" || imageSize === "2K") {
    parameters.imageSize = imageSize;
  } else {
    parameters.imageSize = "2K";
  }

  const response = await postGoogleJson<{
    predictions?: Array<any>;
    generatedImages?: Array<any>;
  }>(`${toModelPath(model)}:predict`, {
    instances: [
      {
        prompt: fullPrompt,
      },
    ],
    parameters,
  });

  const imageData = extractPredictedImageData(response);
  if (imageData) return Uint8Array.from(Buffer.from(imageData, "base64"));

  throw new Error("No image in response");
}

type VertexNoImageResponse = {
  responseId?: unknown;
  modelVersion?: unknown;
  createTime?: unknown;
  promptFeedback?: {
    blockReason?: unknown;
    blockReasonMessage?: unknown;
    safetyRatings?: unknown;
  };
  candidates?: unknown;
};

function summarizeVertexSafetyRatings(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((rating) => {
    if (!rating || typeof rating !== "object") return [];
    const source = rating as Record<string, unknown>;
    const summary: Record<string, unknown> = {};
    for (const key of ["category", "probability", "probabilityScore", "severity", "severityScore"] as const) {
      if (typeof source[key] === "string" || typeof source[key] === "number") summary[key] = source[key];
    }
    if (typeof source.blocked === "boolean") summary.blocked = source.blocked;
    return [summary];
  });
}

/**
 * Keeps the API fields needed to classify a no-image Vertex AI result, while
 * omitting prompts, inline image bytes, and model text content.
 */
function summarizeVertexNoImageResponse(response: VertexNoImageResponse): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of ["responseId", "modelVersion", "createTime"] as const) {
    if (typeof response[key] === "string") summary[key] = response[key];
  }

  if (response.promptFeedback) {
    const { blockReason, blockReasonMessage, safetyRatings } = response.promptFeedback;
    summary.promptFeedback = {
      ...(typeof blockReason === "string" ? { blockReason } : {}),
      ...(typeof blockReasonMessage === "string" ? { hasBlockReasonMessage: true } : {}),
      ...(Array.isArray(safetyRatings) ? { safetyRatings: summarizeVertexSafetyRatings(safetyRatings) } : {}),
    };
  }

  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  summary.candidates = candidates.flatMap((candidate, index) => {
    if (!candidate || typeof candidate !== "object") return [];
    const source = candidate as Record<string, unknown>;
    const content = source.content && typeof source.content === "object"
      ? source.content as Record<string, unknown>
      : {};
    const parts = Array.isArray(content.parts) ? content.parts : [];

    return [{
      index,
      ...(typeof source.finishReason === "string" ? { finishReason: source.finishReason } : {}),
      ...(typeof source.finishMessage === "string" ? { hasFinishMessage: true } : {}),
      ...(Array.isArray(source.safetyRatings)
        ? { safetyRatings: summarizeVertexSafetyRatings(source.safetyRatings) }
        : {}),
      parts: parts.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const sourcePart = part as Record<string, unknown>;
        if (sourcePart.inlineData && typeof sourcePart.inlineData === "object") {
          const inlineData = sourcePart.inlineData as Record<string, unknown>;
          return [{
            kind: "inlineData",
            ...(typeof inlineData.mimeType === "string" ? { mimeType: inlineData.mimeType } : {}),
            hasData: typeof inlineData.data === "string" && inlineData.data.length > 0,
          }];
        }
        if (typeof sourcePart.text === "string") return [{ kind: "text", textLength: sourcePart.text.length }];
        if (sourcePart.fileData && typeof sourcePart.fileData === "object") {
          const fileData = sourcePart.fileData as Record<string, unknown>;
          return [{
            kind: "fileData",
            ...(typeof fileData.mimeType === "string" ? { mimeType: fileData.mimeType } : {}),
          }];
        }
        return [{ kind: "other", keys: Object.keys(sourcePart).sort() }];
      }),
    }];
  });

  return summary;
}

function resolveGcloudBin(): string {
  if (process.env.GCLOUD_BIN) return process.env.GCLOUD_BIN;
  try {
    const found = execFileSync("which", ["gcloud"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (found) return found;
  } catch {}
  const candidates = [
    process.env.HOME ? path.join(process.env.HOME, "google-cloud-sdk", "bin", "gcloud") : null,
    "/opt/homebrew/bin/gcloud",
    "/usr/local/bin/gcloud",
  ].filter((p): p is string => Boolean(p));
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { encoding: "utf8", timeout: 5000 });
      return candidate;
    } catch {}
  }
  throw new Error(
    "Could not locate the gcloud CLI. Install the Google Cloud SDK, or set GCLOUD_BIN to the gcloud binary path.",
  );
}

/** gcloud access tokens last ~60 min; refresh well before that. */
const VERTEX_TOKEN_TTL_MS = 45 * 60 * 1000;
const vertexTokenCache = new Map<string, { token: string; fetchedAt: number }>();

/** Test hook. */
export function __clearVertexTokenCache(): void {
  vertexTokenCache.clear();
}

/**
 * Obtain a Vertex AI bearer token.
 * - No `account`: env overrides (VERTEX_BEARER_TOKEN / GOOGLE_ACCESS_TOKEN) win,
 *   else `gcloud auth print-access-token` for the active account (unchanged).
 * - With `account`: always mints a token for that account via
 *   `CLOUDSDK_CORE_ACCOUNT=<account> gcloud auth print-access-token` (this does
 *   NOT change the user's active gcloud config), cached per-account.
 */
export function getVertexAccessToken(account?: string): string {
  if (!account) {
    // Accountless path: unchanged from before pooling. No caching here — an
    // operator can `gcloud config set account ...` mid-run and the very next
    // call must reflect it (also keeps env-token precedence intact).
    if (process.env.VERTEX_BEARER_TOKEN) return process.env.VERTEX_BEARER_TOKEN;
    if (process.env.GOOGLE_ACCESS_TOKEN) return process.env.GOOGLE_ACCESS_TOKEN;
    try {
      const token = execFileSync(resolveGcloudBin(), ["auth", "print-access-token"], {
        encoding: "utf8",
        timeout: 10000,
      }).trim();
      if (token) return token;
    } catch {}
    throw new Error(
      "Failed to obtain Vertex AI access token via gcloud or environment variables.",
    );
  }

  // Per-account path (pool nodes): cache by the explicit account only.
  const cached = vertexTokenCache.get(account);
  if (cached && Date.now() - cached.fetchedAt < VERTEX_TOKEN_TTL_MS) {
    return cached.token;
  }
  try {
    const token = execFileSync(resolveGcloudBin(), ["auth", "print-access-token"], {
      encoding: "utf8",
      timeout: 10000,
      env: { ...process.env, CLOUDSDK_CORE_ACCOUNT: account },
    }).trim();
    if (token) {
      vertexTokenCache.set(account, { token, fetchedAt: Date.now() });
      return token;
    }
  } catch {}
  throw new Error(
    `Failed to obtain Vertex AI access token for account ${account} via gcloud.`,
  );
}

export function getVertexProjectId(): string {
  if (process.env.VERTEX_PROJECT_ID) return process.env.VERTEX_PROJECT_ID;
  if (process.env.GOOGLE_CLOUD_PROJECT) return process.env.GOOGLE_CLOUD_PROJECT;
  try {
    const proj = execFileSync(resolveGcloudBin(), ["config", "get-value", "project"], {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (proj && proj !== "(unset)") return proj;
  } catch {}
  throw new Error(
    "Could not determine Vertex AI project ID. Set VERTEX_PROJECT_ID, GOOGLE_CLOUD_PROJECT, or configure gcloud's default project.",
  );
}

export function getVertexLocation(): string {
  return process.env.VERTEX_LOCATION || "global";
}

/**
 * Errors that justify failing over to another pool node (transient / quota).
 * Node-level permanent problems (400/401/403/404) return false — retrying on a
 * different node would not help and would waste quota.
 */
export function isVertexFailoverError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const statusMatch = msg.match(/Vertex AI error \((\d{3})\)/);
  if (statusMatch) {
    const status = Number(statusMatch[1]);
    return status === 429 || (status >= 500 && status <= 504);
  }
  return /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket|fetch failed|network|aborted|AbortError|timeout/i.test(
    msg,
  );
}

const VERTEX_REQUEST_TIMEOUT_MS = 180_000;

/** Perform one Vertex :streamGenerateContent call against an explicit target. */
async function doVertexRequest(
  prompt: string,
  model: string,
  args: CliArgs,
  target: { projectId: string; location: string; token: string },
): Promise<Uint8Array> {
  const normalizedModel = normalizeGoogleModelId(model);
  const url = `https://aiplatform.googleapis.com/v1/projects/${target.projectId}/locations/${target.location}/publishers/google/models/${normalizedModel}:streamGenerateContent`;

  const promptWithAspect = addAspectRatioToPrompt(prompt, args.aspectRatio);
  const parts: Array<{
    text?: string;
    inlineData?: { data: string; mimeType: string };
  }> = [];

  for (const refPath of args.referenceImages) {
    const { data, mimeType } = await readImageAsBase64(refPath);
    parts.push({ inlineData: { data, mimeType } });
  }
  parts.push({ text: promptWithAspect });

  const imageConfig: { imageSize: "1K" | "2K" | "4K"; aspectRatio?: string } = {
    imageSize: getGoogleImageSize(args),
  };
  if (args.aspectRatio) {
    imageConfig.aspectRatio = args.aspectRatio;
  }

  console.log(`Generating image with Vertex AI (${normalizedModel})...`, imageConfig);

  // Bounded so a hung request can't hold the pool's L1 ownership lock past its
  // stale-eviction horizon (see POOL_ALL_COOLED_MAX_WAIT_MS in main.ts).
  const res = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(VERTEX_REQUEST_TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${target.token}`,
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI error (${res.status}): ${errText}`);
  }

  const json = (await res.json()) as any;
  // Stream response is an array or single object
  const items = Array.isArray(json) ? json : [json];
  for (const item of items) {
    const imageData = extractInlineImageData(item);
    if (imageData) return Uint8Array.from(Buffer.from(imageData, "base64"));
  }

  const diagnostics = items.map((item, chunkIndex) => ({
    chunkIndex,
    ...summarizeVertexNoImageResponse(item),
  }));
  throw new Error(
    `No image in Vertex AI response. Diagnostics: ${JSON.stringify({ streamChunks: diagnostics })}`,
  );
}

/** Single-node path: resolve target from env / gcloud config (unchanged behavior). */
async function generateWithVertex(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  return doVertexRequest(prompt, model, args, {
    projectId: getVertexProjectId(),
    location: getVertexLocation(),
    token: getVertexAccessToken(),
  });
}

/** Pool path: caller supplies the exact project / location / account to use. */
export async function generateWithVertexNode(
  prompt: string,
  model: string,
  args: CliArgs,
  ctx: VertexExecContext,
): Promise<Uint8Array> {
  const staticToken =
    process.env.VERTEX_BEARER_TOKEN || process.env.GOOGLE_ACCESS_TOKEN || null;
  const allowStatic = process.env.VERTEX_POOL_ALLOW_STATIC_TOKEN === "1";

  if (ctx.account && staticToken && !allowStatic) {
    throw new Error(
      "Vertex pool node has an account but a global VERTEX_BEARER_TOKEN/GOOGLE_ACCESS_TOKEN is set; " +
        "unset it, or set VERTEX_POOL_ALLOW_STATIC_TOKEN=1 to authorize that token for every configured pool project.",
    );
  }

  // With the opt-in, the static token authorizes every project → use it directly
  // and skip per-account minting.
  const useStatic = !!staticToken && (!ctx.account || allowStatic);
  const token = useStatic ? staticToken! : getVertexAccessToken(ctx.account);
  const credSource = useStatic
    ? "static-token"
    : ctx.account
      ? `account:${ctx.account}`
      : "gcloud-default";
  console.log(
    `Vertex pool node project=${ctx.project} location=${ctx.location} cred=${credSource}`,
  );

  return doVertexRequest(prompt, model, args, {
    projectId: ctx.project,
    location: ctx.location,
    token,
  });
}

export async function generateImage(
  prompt: string,
  model: string,
  args: CliArgs,
): Promise<Uint8Array> {
  if (args.provider === "vertex") {
    return generateWithVertex(prompt, model, args);
  }

  if (isGoogleImagen(model)) {
    if (args.referenceImages.length > 0) {
      throw new Error(
        "Reference images are not supported with Imagen models. Use a Gemini multimodal model such as gemini-3-pro-image, gemini-3.1-flash-image, gemini-3-pro-image-preview, gemini-3-flash-preview, or gemini-3.1-flash-image-preview.",
      );
    }
    return generateWithImagen(prompt, model, args);
  }

  if (!isGoogleMultimodal(model) && args.referenceImages.length > 0) {
    throw new Error(
      "Reference images are only supported with Gemini multimodal models such as gemini-3-pro-image, gemini-3.1-flash-image, gemini-3-pro-image-preview, gemini-3-flash-preview, or gemini-3.1-flash-image-preview.",
    );
  }

  return generateWithGemini(prompt, model, args);
}
