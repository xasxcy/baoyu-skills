// PROVIDERS is the runtime-canonical provider list. It drives the CLI --provider
// validation, the rate-limit Record, and the batch log loop in main.ts (see B0
// in workspace/dev/2026-08-13-image-providers/PLAN-v3.md). Provider-specific
// module loading and credential detection intentionally keep explicit branches
// rather than being derived from this array.
//
// NOTE: this repo has no tsconfig.json / no `typescript` dependency; `tsx` only
// transpiles, it does not type-check. The runtime assertion in main.test.ts
// (that PROVIDERS' key set matches DEFAULT_PROVIDER_RATE_LIMITS' and
// ExtendConfig.default_model's key sets) is the actual enforcement here — this
// const alone gives no compile-time guarantee that every consumer stayed in sync.
export const PROVIDERS = [
  "google",
  "openai",
  "openrouter",
  "dashscope",
  "siliconflow",
  "zai",
  "minimax",
  "replicate",
  "jimeng",
  "seedream",
  "azure",
  "codex-cli",
  "agy-cli",
  "agnes",
  "vertex",
] as const;

export type Provider = (typeof PROVIDERS)[number];
export type Quality = "normal" | "2k";
export type OpenAIImageApiDialect = "openai-native" | "ratio-metadata";
export type ResponseFormat = "file" | "url";

export type CliArgs = {
  prompt: string | null;
  promptFiles: string[];
  imagePath: string | null;
  provider: Provider | null;
  model: string | null;
  aspectRatio: string | null;
  aspectRatioSource?: "cli" | "task" | "config" | null;
  size: string | null;
  quality: Quality | null;
  imageSize: string | null;
  imageSizeSource?: "cli" | "task" | "config" | null;
  imageApiDialect: OpenAIImageApiDialect | null;
  responseFormat: ResponseFormat | null;
  referenceImages: string[];
  n: number;
  batchFile: string | null;
  jobs: number | null;
  json: boolean;
  help: boolean;
};

export type BatchTaskInput = {
  id?: string;
  prompt?: string | null;
  promptFiles?: string[];
  image?: string;
  provider?: Provider | null;
  model?: string | null;
  ar?: string | null;
  size?: string | null;
  quality?: Quality | null;
  imageSize?: "1K" | "2K" | "4K" | null;
  imageApiDialect?: OpenAIImageApiDialect | null;
  responseFormat?: ResponseFormat | null;
  ref?: string[];
  n?: number;
};

export type BatchFile =
  | BatchTaskInput[]
  | {
      tasks: BatchTaskInput[];
      jobs?: number | null;
    };

export type ExtendConfig = {
  version: number;
  default_provider: Provider | null;
  default_quality: Quality | null;
  default_aspect_ratio: string | null;
  default_image_size: "1K" | "2K" | "4K" | null;
  default_image_api_dialect: OpenAIImageApiDialect | null;
  default_model: {
    google: string | null;
    openai: string | null;
    openrouter: string | null;
    dashscope: string | null;
    siliconflow: string | null;
    zai: string | null;
    minimax: string | null;
    replicate: string | null;
    jimeng: string | null;
    seedream: string | null;
    azure: string | null;
    "codex-cli": string | null;
    "agy-cli": string | null;
    agnes: string | null;
    vertex: string | null;
  };
  batch?: {
    max_workers?: number | null;
    provider_limits?: Partial<
      Record<
        Provider,
        {
          concurrency?: number | null;
          start_interval_ms?: number | null;
        }
      >
    >;
  };
  /** Vertex rotation pool: JSON array string of {account?,project,location?,weight?} nodes. */
  vertex_pool_config?: string | null;
  /** "round-robin" (default) | "weighted-random" */
  vertex_pool_routing?: string | null;
  /** Local per-node cooldown after a failover-class error (default 60). */
  vertex_pool_cooldown_seconds?: number | null;
};
