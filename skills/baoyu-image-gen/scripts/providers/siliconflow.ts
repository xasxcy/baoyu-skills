import path from "node:path";
import { readFile, stat } from "node:fs/promises";

import type { CliArgs } from "../types";

const DEFAULT_MODEL = "Qwen/Qwen-Image";
const MAX_REFERENCE_IMAGES = 3;
const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const IMAGE_SIZES: Record<string, string> = {
  "1:1": "1328x1328",
  "16:9": "1664x928",
  "4:3": "1472x1104",
  "3:4": "1104x1472",
  "9:16": "928x1664",
};

type SiliconFlowResponse = {
  images?: Array<{ url?: string }>;
  data?: Array<{ url?: string }>;
};

function getApiKey(): string | null {
  return process.env.SILICONFLOW_API_KEY || null;
}

function getBaseUrl(): string {
  return (process.env.SILICONFLOW_BASE_URL || "https://api.siliconflow.cn/v1").replace(/\/+$/g, "");
}

export function getDefaultModel(): string {
  return process.env.SILICONFLOW_IMAGE_MODEL || DEFAULT_MODEL;
}

export function getModelFamily(model: string): "text" | "edit" | "edit2509" | "unknown" {
  if (model === "Qwen/Qwen-Image") return "text";
  if (model === "Qwen/Qwen-Image-Edit") return "edit";
  if (model === "Qwen/Qwen-Image-Edit-2509") return "edit2509";
  return "unknown";
}

function getImageMime(filePath: string, bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP") return "image/webp";
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function loadReferenceImage(filePath: string): Promise<string> {
  const bytes = await readFile(filePath);
  return `data:${getImageMime(filePath, bytes)};base64,${bytes.toString("base64")}`;
}

export function resolveImageSize(args: Pick<CliArgs, "size" | "aspectRatio">): string {
  if (args.size) return args.size.replace("*", "x");
  return IMAGE_SIZES[args.aspectRatio || "1:1"] || IMAGE_SIZES["1:1"];
}

export function validateArgs(model: string, args: CliArgs): void {
  const family = getModelFamily(model);
  if (family === "unknown") {
    throw new Error("SiliconFlow supports Qwen/Qwen-Image, Qwen/Qwen-Image-Edit, and Qwen/Qwen-Image-Edit-2509 in this skill.");
  }
  const count = args.referenceImages.length;
  if (family === "text" && count > 0) {
    throw new Error("Qwen/Qwen-Image is text-to-image only. Use Qwen/Qwen-Image-Edit or Qwen/Qwen-Image-Edit-2509 for reference images.");
  }
  if ((family === "edit" || family === "edit2509") && count === 0) {
    throw new Error(`${model} requires at least one reference image.`);
  }
  if (family === "edit" && count > 1) {
    throw new Error("Qwen/Qwen-Image-Edit accepts exactly one reference image. Use Qwen/Qwen-Image-Edit-2509 for up to three.");
  }
  if (count > MAX_REFERENCE_IMAGES) {
    throw new Error(`SiliconFlow Qwen image editing accepts at most ${MAX_REFERENCE_IMAGES} reference images. Received ${count}.`);
  }
}

async function validateReferenceImageSizes(referenceImages: string[]): Promise<void> {
  for (const filePath of referenceImages) {
    const info = await stat(filePath);
    if (info.size > MAX_REFERENCE_BYTES) {
      throw new Error(`SiliconFlow reference images must be at most 10MB each. ${path.basename(filePath)} is ${info.size} bytes.`);
    }
  }
}

export async function buildRequestBody(prompt: string, model: string, args: CliArgs): Promise<Record<string, unknown>> {
  validateArgs(model, args);
  const family = getModelFamily(model);
  const body: Record<string, unknown> = { model, prompt };
  if (family === "text") {
    body.image_size = resolveImageSize(args);
    return body;
  }

  await validateReferenceImageSizes(args.referenceImages);
  const images = await Promise.all(args.referenceImages.map(loadReferenceImage));
  body.image = images[0]!;
  if (family === "edit2509") {
    if (images[1]) body.image2 = images[1];
    if (images[2]) body.image3 = images[2];
  }
  return body;
}

export async function extractImageFromResponse(result: SiliconFlowResponse): Promise<Uint8Array> {
  const imageUrl = result.images?.[0]?.url || result.data?.[0]?.url;
  if (!imageUrl) {
    console.error("Response:", JSON.stringify(result, null, 2));
    throw new Error("No image URL in SiliconFlow response.");
  }
  const imageResponse = await fetch(imageUrl);
  if (!imageResponse.ok) throw new Error(`Failed to download SiliconFlow image (${imageResponse.status}).`);
  return new Uint8Array(await imageResponse.arrayBuffer());
}

export async function generateImage(prompt: string, model: string, args: CliArgs): Promise<Uint8Array> {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error("SILICONFLOW_API_KEY is required");
  const body = await buildRequestBody(prompt, model, args);
  const response = await fetch(`${getBaseUrl()}/images/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`SiliconFlow API error (${response.status}): ${await response.text()}`);
  }
  return extractImageFromResponse(await response.json() as SiliconFlowResponse);
}
