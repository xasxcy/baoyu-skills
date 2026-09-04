# `agy-imagegen` Backend

Generate images via Antigravity CLI's (`agy`) built-in `generate_image` tool from non-agy runtimes (e.g., Claude Code). The wrapper spawns `agy -p ... --output-format json` and lets the user's existing Antigravity subscription drive image generation — no separate image API key required.

This backend implements the `preferred_image_backend: agy-imagegen` config key referenced in several `SKILL.md` files across this repo.

## Features

| Feature | Status |
|---------|--------|
| **Reliability**: retry + exponential backoff | Default 2 retries |
| **Verification**: confirms `generate_image` was actually invoked (not bypassed) | Requires a `generate_image` tool-call (or legacy `GENERATE_IMAGE` step) in the run's `transcript.jsonl`, **and** a real output file recovered from `brain/<conversation_id>/` |
| **Verification**: JPEG/PNG magic-byte sanity check | ✓ |
| **Reference images**: up to 3, passed as absolute paths into `ImagePaths` | ✓ — confirmed to preserve character/subject consistency across generations, see below |
| **Idempotency cache**: reuses output for same prompt+aspect+model+refs | `--cache-dir` |
| **Structured logging**: JSONL log file | `--log-file` |
| **Token usage returned** | Embedded in result JSON |
| **Unit tests** | parser / cache / validator / spawn / main suites (`bun test`) |
| **Error classification**: retryable vs non-retryable | 12 `error_kind` values |

## Why this backend

| Scenario | Conventional backend | This backend |
|----------|---------------------|--------------|
| You have an Antigravity subscription | Per-image API costs add up | Subscription already covers it — zero marginal API cost |
| No image API key available | `baoyu-image-gen` needs an API key | `agy` login is enough |
| Need character/subject consistency across images | Requires a ref-capable provider with careful prompt engineering | `--ref` reference images reliably hold face/hair/outfit across generations (verified, see below) |

## Prerequisites

`agy` (Antigravity CLI) must be installed and authenticated:

```bash
agy --version
agy models        # confirms auth is working
```

`bun` is required for running the wrapper. On macOS:

```bash
brew install oven-sh/bun/bun
```

If `bun` is not on `PATH`, fall back to `npx -y bun packages/baoyu-agy-imagegen/src/main.ts …`.

## Usage

### Direct CLI

```bash
# Inline prompt
bun packages/baoyu-agy-imagegen/src/main.ts \
  --image /tmp/cat.jpg \
  --prompt "A friendly orange cat, watercolor"

# Prompt from file, with a reference image for style/character consistency
bun packages/baoyu-agy-imagegen/src/main.ts \
  --image cover.jpg \
  --prompt-file prompts/01-cover.md \
  --aspect 16:9 \
  --ref character-sheet.jpg

# Verbose mode for debugging
bun packages/baoyu-agy-imagegen/src/main.ts -v --image dog.jpg --prompt "A corgi" --aspect 1:1
```

### Through `baoyu-image-gen`

```bash
${BUN_X} skills/baoyu-image-gen/scripts/main.ts \
  --provider agy-cli \
  --prompt "A friendly orange cat, watercolor" \
  --image /tmp/cat.jpg \
  --ar 1:1 \
  --ref /tmp/character-sheet.jpg
```

The `agy-cli` provider spawns the bundled `agy-imagegen` TS entrypoint internally and surfaces its retry/cache machinery through baoyu-image-gen's standard CLI + batch flow.

On success, stdout emits a single JSON line:

```json
{"status":"ok","path":"/tmp/cat.jpg","bytes":293211,"elapsed_seconds":19}
```

On failure, exit code is non-zero and stdout contains a JSON line with `error` and `error_kind` (see Structured Output below).

### Enabling within image skills

Image-generating skills (e.g., `baoyu-cover-image`, `baoyu-article-illustrator`) already support a `preferred_image_backend` preference. To route them through this backend, set the following in the corresponding `EXTEND.md`:

```yaml
# ~/.baoyu-skills/baoyu-cover-image/EXTEND.md
preferred_image_backend: agy-imagegen
```

When the LLM runs the skill, it reads the preference and — guided by the `### agy-imagegen Backend` section in `CLAUDE.md` — invokes `bun packages/baoyu-agy-imagegen/src/main.ts`.

> **Note**: The integration is mediated by the LLM reading `CLAUDE.md`. It is not a hard binding. If a skill does not route to the backend automatically, mentioning it explicitly in the prompt works.

## Reference images and character consistency

`agy`'s `generate_image` tool accepts up to 3 absolute image paths via its `ImagePaths` argument. This wrapper's `--ref <file>` flag (repeatable, max 3) forwards them.

**Verified behavior**: a base character was generated once (purple bob haircut, round glasses, teal turtleneck, flat-vector style). A second prompt — deliberately omitting any redescription of hair, glasses, or outfit color, only saying "using the exact same character shown in the reference image" — was run with `--ref` pointing at the first image. The second image preserved the face, hairstyle, glasses, and outfit exactly, in a new pose and setting. This makes the backend usable for digital-human / recurring-character workflows (consistent avatar across a batch of scenes, comic panels, slide decks, etc.) without re-describing appearance in every prompt.

Pass reference images the same way as any other ref-capable provider:

```bash
${BUN_X} skills/baoyu-image-gen/scripts/main.ts \
  --provider agy-cli \
  --prompt "Same character, now waving at the camera from a desk" \
  --image scene.jpg \
  --ref character-sheet.jpg
```

## Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--image <path>` | ✓ | Output image path (JPEG bytes; keep a `.jpg`/`.jpeg` extension; absolute recommended) |
| `--prompt <text>` | one of | Prompt string (mutually exclusive with `--prompt-file`) |
| `--prompt-file <path>` | one of | Read prompt from file (mutually exclusive with `--prompt`) |
| `--aspect <ratio>` | | Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`. Default `1:1` |
| `--model <name>` | | `agy --model` to run under. Default `gemini-3.7-flash-medium` |
| `--ref <file>` | | Reference image path (repeatable, max 3) |
| `--timeout <ms>` | | `agy` timeout in ms. Default `300000` |
| `--retries <n>` | | Retry count on retryable errors. Default `2` (total attempts = retries + 1) |
| `--retry-delay <ms>` | | Base delay between retries (exponential backoff). Default `1500` |
| `--cache-dir <path>` | | Enable idempotency cache (reuses output for same prompt+aspect+model+refs) |
| `--log-file <path>` | | Structured JSONL log path (appended) |
| `-v` / `--verbose` | | Mirror log entries to stderr |
| `-h` / `--help` | | Show usage |

## Structured Output

On success, stdout contains a single JSON line:

```json
{
  "status": "ok",
  "path": "/tmp/owl.jpg",
  "bytes": 516395,
  "elapsed_seconds": 14,
  "conversation_id": "c88ee5a7-4ba3-4345-b609-1b48bff4edbd",
  "attempts": 1,
  "cached": false,
  "usage": {
    "input": 22167,
    "cached_input": 16290,
    "output": 198,
    "thinking": 126
  }
}
```

Cache hits return with `elapsed_seconds: 0`, `cached: true`, `attempts: 0`.

On failure, exit code is `1` and the JSON contains `error` and `error_kind`:

```json
{
  "status": "error",
  "error": "generate_image was not invoked in <conversation_id>",
  "error_kind": "no_image_gen_tool_use"
}
```

## Error Kinds

| `error_kind` | Retryable | Meaning |
|--------------|-----------|---------|
| `agy_not_installed` | ✗ | `agy` CLI not found |
| `invalid_args` | ✗ | Argument parsing error |
| `prompt_file_missing` | ✗ | `--prompt-file` path does not exist |
| `spawn_failed` | ✓ | `agy` exited non-zero |
| `timeout` | ✓ | Exceeded `--timeout` |
| `no_image_gen_tool_use` | ✓ | Agent did not invoke `generate_image` (it took another path), or the transcript's saved-file path could not be found |
| `output_missing` | ✓ | The file the transcript says was saved is missing on disk |
| `invalid_jpeg` | ✓ | Output is not a valid JPEG or PNG |
| `quota_exhausted` | ✓ | agy's upstream image quota / 429 `RESOURCE_EXHAUSTED` (recovered from a transcript diagnostic step). Retryable because that pool resets on a short delay |
| `location_not_supported` | ✗ | Google's geo/ASN gate on the model call — `FAILED_PRECONDITION (code 400): User location is not supported for the API use`. A property of the egress IP, not the request, so retrying from the same network cannot help |
| `agent_refused` | ✓ | agy reported a non-`SUCCESS` status, or produced no `conversation_id` |
| `malformed_json` | ✓ | agy's `--output-format json` stdout could not be parsed even after control-character sanitization |

### `location_not_supported` — how it's detected and why it's not retryable

The geo gate fails at agy's `calling model` step and leaves **nothing** in the run's brain-dir transcript (just `USER_INPUT` + a contentless `PLANNER_RESPONSE`) and only a generic `"Agent execution terminated due to error."` in the stdout JSON. The real diagnostic line lives only in agy's per-invocation server log at `~/.gemini/antigravity-cli/log/cli-<timestamp>.log`:

```
agent executor error: calling model: FAILED_PRECONDITION (code 400): User location is not supported for the API use.
```

So the wrapper, when verification finds no image, additionally: (1) scans agy's own transcript diagnostic steps (`PLANNER_RESPONSE` / `ERROR_MESSAGE`) for the phrase — a forward hedge in case agy starts surfacing it there like it now does for quota; then (2) looks at `log/cli-*.log`. `verifyGeneration` **requires** this run's `agy` spawn instant (`AgyRunResult.startedAtMs`). Every stage is bounded: the directory is enumerated with a streaming `opendir` that keeps only the newest ~2048 `cli-<timestamp>.log` names (they sort chronologically, so this needs no `stat`); those are `stat`ed and kept only if their mtime is at/after the spawn instant minus a small filesystem-mtime grace (coarse-granularity filesystems round mtimes down); that window is this run's own lifetime — seconds — so the survivors are few and *every* one is opened and content-checked against this run's `conversation_id` with **no newest-N cap ahead of that check** (concurrent `agy` invocations cannot crowd this run's logs out of view). Each file is read whole if ≤ 2 MiB (every real per-invocation log is far smaller — a geo-gated run aborts in ~1 s) and otherwise as a bounded head + tail slice, so the id header (near the start) and the geo line (near the end) are both covered. Matches are joined; a runaway guard caps the *correlated* set and a large read ceiling guards a pathologically full `log/` dir. A match → `location_not_supported`, deliberately **absent from `RETRYABLE`**: the fix is to change the egress (a supported region, ideally a residential/ISP IP rather than a datacenter/hosting range — see below), which no in-process retry can do. The `conversation_id` is fresh per run (agy is never invoked with `--continue`), so widening the lower bound backwards by the mtime grace can't admit a stale run's log for this id.

**What the gate actually checks** (from community reverse-engineering, not an official statement): the discriminator is the **egress IP's region *and* ASN/hosting classification**, evaluated on the model-call path only (`agy models` and other metadata calls are unaffected). Datacenter/VPS/VPN IP ranges are rejected even when they geolocate to an otherwise-supported country; the same country's residential/ISP IP passes. Reports of this cluster through 2026, with a visible tightening around 2026-09-01. Supported-country lists themselves (Singapore included) were not observed to shrink. Practical guidance: route agy through a residential/ISP egress in a supported region; a datacenter node that works today may stop on the next tightening.

## Measured Performance

| Metric | Value |
|--------|-------|
| First-run latency | 15–35 s |
| Cache-hit latency | < 0.3 s |
| Output dimensions | 1024×1024 at `1:1`; other aspect ratios follow agy's own sizing |
| Output format | **JPEG** (not PNG — see Design Decisions) |
| Token usage per call | ~20k input (~16k cached) + ~200–400 output |
| Quota source | Antigravity subscription |
| Default timeout | 300 s (5 min) |

## Limitations & Risks

1. **Output is JPEG, not PNG.** `agy`'s `generate_image` always writes a `.jpg` file regardless of the requested `ImageName`. The wrapper copies bytes verbatim without transcoding. If a caller explicitly requests a `.png` output path, the file will contain JPEG bytes under a `.png` name — this mirrors an existing seam in `baoyu-image-gen` (`normalizeOutputImagePath` only applies a provider's default extension when the caller omits one) and is not specific to this backend.
2. **ToS gray area.** `agy`'s `generate_image` tool is designed for interactive use. Invoking it programmatically via `agy -p` from an external agent is not explicitly addressed by current Google/Antigravity policies. Suggested guardrails:
   - Personal, low-volume use is reasonable.
   - Not recommended for production automation or high-volume batch jobs.
   - Users are responsible for ensuring their usage complies with applicable terms of service.
3. **`agy`'s JSON output is not always strict JSON.** A raw, unescaped control character (e.g., a bare newline) inside the `response` field has been observed, which both V8's and Python's JSON parsers reject. The wrapper retries with control characters escaped before giving up (`malformed_json` if that still fails).
4. **No concurrency lock.** Unlike `baoyu-codex-imagegen` (whose lock exists because `$CODEX_HOME/generated_images/` is shared across threads), each `agy` run gets its own `brain/<conversation_id>/` directory with no cross-run sharing, so concurrent invocations are safe without a lock.
5. **Egress geo/ASN gate.** The model-call path is gated on the exit IP's region *and* datacenter/hosting classification (`location_not_supported` — see Error Kinds). A datacenter/VPS/VPN egress is rejected even from a supported country; this has been tightening through 2026. Runs need a residential/ISP egress in a supported region. Not something the wrapper can retry around — it classifies the failure as non-retryable and stops.
6. **Geo-gate detection reads a shared log.** Because that failure leaves nothing in the brain dir or stdout, detection reads `~/.gemini/antigravity-cli/log/cli-*.log` files created at/after this run's spawn instant and mentioning its `conversation_id`. If agy changes that log's path or format the classification silently degrades back to `no_image_gen_tool_use` (retryable) — the run still fails, just less informatively.

## Troubleshooting

| Symptom | `error_kind` | Resolution |
|---------|--------------|------------|
| `command not found: agy` | `agy_not_installed` | Install Antigravity CLI and run `agy models` to confirm auth |
| `agy` fails to spawn | `spawn_failed` | Check `agy models` output; inspect the `raw_log` path in verbose mode |
| Timeout | `timeout` | Pass `--timeout 600000` (10 min) for slow networks |
| Agent skipped `generate_image` | `no_image_gen_tool_use` | Auto-retries; consider sharpening the prompt — abstract prompts let the agent wander |
| Output missing | `output_missing` | The transcript said a file was saved but it's gone; check `raw_log` and the `brain/<conversation_id>/` directory |
| `User location is not supported` | `location_not_supported` | **Not retried.** Route agy through a supported region — ideally a residential/ISP IP, not a datacenter/VPS range. `agy models` still working is not a sign the egress is fine; only the `calling model` path is gated. See the `location_not_supported` section above |
| Quota / 429 | `quota_exhausted` | Auto-retries with backoff (the Antigravity image pool resets in seconds). Persistent → wait, or switch account/egress |
| Low image quality | — | Sharpen the prompt, try a different aspect, or supply `--ref` |

## Architecture

```
packages/baoyu-agy-imagegen/
├── src/
│   ├── main.ts             # parseArgs → cache → retry loop → emit JSON (`#!/usr/bin/env bun`)
│   ├── types.ts            # CliOptions, GenerateResult, GenError, ErrorKind
│   ├── spawn.ts            # spawn agy -p ...; read transcript.jsonl; read server cli-*.log (geo gate)
│   ├── parser.ts           # sanitize + parse stdout JSON; parse transcript.jsonl; quota + geo-gate detectors
│   ├── validator.ts        # verify generate_image invocation + brain-dir scan + JPEG/PNG magic + atomic copy
│   ├── cache.ts            # cacheKey(sha256), lookup/store
│   ├── logger.ts           # JsonLogger (verbose stderr + JSONL file)
│   ├── main.test.ts  ├── parser.test.ts  ├── cache.test.ts
│   ├── spawn.test.ts └── validator.test.ts   # all bun:test
├── package.json            # workspace package: `bin` → `src/main.ts`, no build step
└── README.md
```

Run tests:

```bash
cd packages/baoyu-agy-imagegen && bun test
```

## Internal Flow

```mermaid
flowchart LR
    CC[Claude Code / any caller]
    WRAPPER[bun packages/baoyu-agy-imagegen/<br/>src/main.ts]
    AGY["agy -p ...<br/>--output-format json"]
    AGENT[agy agent]
    TOOL[generate_image built-in tool]
    BRAIN["~/.gemini/antigravity-cli/<br/>brain/{conversation_id}/<br/>(transcript.jsonl + output file)"]
    SRVLOG["~/.gemini/antigravity-cli/log/<br/>cli-*.log (geo-gate diagnostic)"]
    OUT[/specified OUTPUT path/]

    CC -->|exec wrapper| WRAPPER
    WRAPPER -->|-p instruction| AGY
    AGY --> AGENT
    AGENT -->|tool call| TOOL
    TOOL -->|writes file| BRAIN
    AGY -->|conversation_id| WRAPPER
    WRAPPER -->|"verify: tool-call in transcript + scan dir for output"| BRAIN
    WRAPPER -.->|"only if no image: classify failure<br/>(quota / location_not_supported)"| SRVLOG
    WRAPPER -->|copyFile, atomic rename| OUT

    classDef cc fill:#1e40af,color:#fff,stroke:#93c5fd
    classDef agy fill:#7c2d12,color:#fff,stroke:#fdba74
    class CC,WRAPPER cc
    class AGY,AGENT,TOOL,BRAIN,SRVLOG agy
```

## Design Decisions

1. **Pure TypeScript entrypoint** — `src/main.ts` carries a `#!/usr/bin/env bun` shebang and is the sole entry, matching the project's `skills/<skill>/scripts/main.ts` convention.
2. **The wrapper recovers the output file itself — the spawned agent never hands it a path.** Unlike `baoyu-codex-imagegen` (where the agent must `cp`/`mv` the rendered image itself, requiring `--sandbox danger-full-access`), this wrapper, after the run, locates the image inside `brain/<conversation_id>/` by `readdir` + name pattern (newest `agy_imagegen_output*.{jpg,jpeg,png}` by mtime) and copies it into place with `node:fs/promises`. The recovered path is `brainDir(...) + a readdir entry name`, so it is inside the per-run directory by construction — nothing the model wrote is used as a filesystem path. A legacy fallback still reads a `"saved at <path>"` string from an old-format `GENERATE_IMAGE` step, but resolves it against the brain dir and rejects anything that escapes. This is what lets the wrapper run agy under `--sandbox --dangerously-skip-permissions` (terminal-restricted) rather than a fully permissive mode, without depending on the prompt's own "don't touch the filesystem" wording as a security control.
3. **Trust the transcript + a real file, not the top-level JSON response** — the top-level `--output-format json` response is freeform text the model wrote; trusting it alone would let a model that merely *describes* success (without calling the tool) pass verification. Verification requires both a `generate_image` tool-call in the transcript **and** an actual output file in the brain dir. (Current agy no longer emits a distinct `GENERATE_IMAGE` step or any "saved at" path text — see the brain-dir scan above; the tool-call name in `PLANNER_RESPONSE` is the invocation evidence now.)
4. **No `--continue`/`-c`/`--conversation`, ever** — every run starts a fresh conversation, so its `brain/<conversation_id>/` directory contains only that run's output. This is what makes "a file exists in this directory" trustworthy evidence, with no cross-run ambiguity to guard against.
   - **One read reaches outside that directory**: geo-gate detection reads `~/.gemini/antigravity-cli/log/cli-*.log`, a shared, not per-conversation, location. It's a bounded, best-effort *read* (files at/after this run's spawn instant, matched by `conversation_id`, per-file byte-capped) used only to classify a failure — never to source a file path or anything that gets copied — so it doesn't widen the path-injection surface that decisions #2/#4 close.
5. **Shared package, not a skill** — this backend is a CLI utility that skills route to via `preferred_image_backend` and that `baoyu-image-gen --provider agy-cli` spawns internally. It lives under `packages/` alongside `baoyu-codex-imagegen` because it has no `SKILL.md` and is never loaded directly by an agent.
6. **No file lock** — `baoyu-codex-imagegen`'s lock exists to serialize access to a directory shared across Codex threads (`$CODEX_HOME/generated_images/`). `agy`'s per-conversation `brain/` directory has no such sharing, so a lock was dropped rather than inherited.

## Related Files

| File | Role |
|------|------|
| `packages/baoyu-agy-imagegen/src/main.ts` | TypeScript CLI entrypoint (`#!/usr/bin/env bun`) |
| `packages/baoyu-agy-imagegen/src/` | TypeScript implementation |
| `packages/baoyu-agy-imagegen/package.json` | Workspace manifest |
| `skills/baoyu-image-gen/scripts/providers/agy-cli.ts` | Provider adapter that lets `baoyu-image-gen --provider agy-cli` spawn this wrapper |
| `skills/baoyu-image-gen/scripts/agy-imagegen/` | Bundled copy of `packages/baoyu-agy-imagegen/src/` for skill self-containment (kept in sync via `scripts/sync-agy-imagegen.sh`) |
| `docs/agy-imagegen-backend.md` | This document |
| `CLAUDE.md` | Tells LLMs how to invoke this backend |
| `.github/workflows/agy-imagegen-tests.yml` | CI unit tests |
