# baoyu-agy-imagegen

Generate images via Antigravity CLI's (`agy`) built-in `generate_image` tool from non-agy runtimes (e.g., Claude Code). The wrapper spawns `agy -p ... --output-format json` and lets the user's existing Antigravity subscription drive image generation — no separate image API key required.

This package implements the `preferred_image_backend: agy-imagegen` config key referenced across the `baoyu-skills` plugin and is the engine behind `baoyu-image-gen --provider agy-cli`.

## Layout

```
packages/baoyu-agy-imagegen/
├── src/
│   ├── main.ts             # CLI orchestrator (executable via `#!/usr/bin/env bun`)
│   ├── spawn.ts            # agy child-process wrapper + transcript.jsonl reader
│   ├── parser.ts           # stdout JSON sanitizer + transcript parser
│   ├── validator.ts        # generate_image-invocation + JPEG/PNG verification + atomic copy
│   ├── cache.ts            # SHA256 idempotency cache
│   ├── logger.ts           # Structured JSONL logging
│   ├── types.ts            # Shared types and `GenError`
│   └── *.test.ts           # Bun unit tests
└── package.json            # `bin` points to `src/main.ts`
```

## Prerequisites

`agy` (Antigravity CLI) must be installed and authenticated:

```bash
agy --version
agy models        # confirms auth is working
```

`bun` is required for running the wrapper:

```bash
brew install oven-sh/bun/bun
```

If `bun` is not on `PATH`, `npx -y bun src/main.ts …` works as a fallback.

## Usage

```bash
bun src/main.ts \
  --image cover.jpg \
  --prompt-file prompts/01-cover.md \
  --aspect 16:9 \
  --cache-dir ~/.cache/baoyu-agy-imagegen

# Without bun installed
npx -y bun src/main.ts --image cover.jpg --prompt "..."
```

Stdout emits a single JSON line:

```json
{"status":"ok","path":"…","bytes":516395,"elapsed_seconds":14,"conversation_id":"…","attempts":1,"cached":false,"usage":{…}}
```

On failure:

```json
{"status":"error","path":"…","bytes":0,"error":"…","error_kind":"timeout"}
```

`error_kind` values: `agy_not_installed`, `invalid_args`, `prompt_file_missing`, `spawn_failed`, `timeout`, `no_image_gen_tool_use`, `output_missing`, `invalid_jpeg`, `quota_exhausted`, `location_not_supported`, `agent_refused`, `malformed_json`.

`location_not_supported` (non-retryable) is Google's geo/ASN gate on the model call (`FAILED_PRECONDITION (code 400): User location is not supported for the API use`). Route `agy` through a supported region — ideally a residential/ISP IP, not a datacenter range. See [docs/agy-imagegen-backend.md](../../docs/agy-imagegen-backend.md#error-kinds).

## Options

| Flag | Description |
|---|---|
| `--image <path>` | Output image path (required). Bytes are JPEG — keep a `.jpg`/`.jpeg` extension |
| `--prompt <text>` | Prompt text |
| `--prompt-file <path>` | Read prompt from file (mutually exclusive with `--prompt`) |
| `--aspect <ratio>` | Aspect ratio: `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`. Default: `1:1` |
| `--model <name>` | `agy --model` to run under. Default: `gemini-3.7-flash-medium` |
| `--ref <file>` | Reference image (repeatable, max 3) |
| `--timeout <ms>` | agy timeout in ms. Default: `300000` |
| `--retries <n>` | Retry attempts on retryable errors. Default: `2` |
| `--retry-delay <ms>` | Base retry delay (exponential). Default: `1500` |
| `--cache-dir <path>` | Enable idempotency cache. Disabled by default. |
| `--log-file <path>` | Append structured JSONL log |
| `-v, --verbose` | Verbose stderr logging |
| `-h, --help` | Show help |

## Test

```bash
cd packages/baoyu-agy-imagegen
bun test
```

## Design notes

- **Output is JPEG, not PNG.** `agy`'s `generate_image` tool always writes a `.jpg` file regardless of the requested `ImageName`. The wrapper copies those bytes verbatim; it does not transcode.
- **No shell copy in the instruction.** Unlike `baoyu-codex-imagegen` (where the spawned agent must `cp` the file itself), this wrapper reads `~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript.jsonl` after the run, extracts the exact saved-file path from the `GENERATE_IMAGE` step, and copies it into place itself with `node:fs/promises`. The instruction tells the model not to touch the filesystem at all — this removes a path-injection surface and matches this repo's array-form-spawn convention (see `CLAUDE.md`).
- **No `--continue`/`-c`/`--conversation`.** Every run is a fresh conversation, so its `brain/<conversation_id>/` directory contains only this run's output — there is no cross-run ambiguity to guard against (unlike `$CODEX_HOME/generated_images/`, which is shared across threads).
- **`agy`'s `--output-format json` is not always strict JSON.** Observed output can contain a raw, unescaped newline inside the `response` string field, which both V8's and Python's JSON parsers reject. `parser.ts` retries with control characters escaped before giving up.
- **No file lock.** `baoyu-codex-imagegen`'s lock existed to serialize access to a directory shared across threads; agy's per-conversation `brain/` directory has no such sharing, so it was dropped rather than inherited.

## Trade-offs

- Slower than direct API calls (agent cold-start + reasoning before the tool call), except on cache hits
- Uses your Antigravity subscription — programmatic use of `agy -p` falls into the same terms as interactive use
- Requires `agy` CLI and an active login session

See [`docs/agy-imagegen-backend.md`](../../docs/agy-imagegen-backend.md) for the full background.
