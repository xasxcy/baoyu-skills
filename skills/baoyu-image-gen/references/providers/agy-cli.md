# Antigravity CLI (`--provider agy-cli`)

Read when the user picks `--provider agy-cli`, sets `default_provider: agy-cli`, or asks for "Antigravity image generation" / "generate with agy" / needs a recurring character/digital-human look held consistent across images. This provider is a thin baoyu-image-gen wrapper around the bundled `scripts/agy-imagegen/main.ts` (synced from `packages/baoyu-agy-imagegen`), which spawns `agy -p ... --output-format json --dangerously-skip-permissions --sandbox` and routes the request to Antigravity CLI's built-in `generate_image` tool. The Antigravity CLI uses the **user's Antigravity subscription** — no separate image API key is read or sent.

## Prerequisites

```bash
agy --version
agy models        # confirms auth is working
```

`bun` is required for running the underlying wrapper (`scripts/agy-imagegen/main.ts`, carrying `#!/usr/bin/env bun`). If `bun` is missing from the runtime, `npx -y bun` works as a fallback.

## Selection

- **Never auto-selected.** `detectProvider` only picks `agy-cli` when it is pinned explicitly: pass `--provider agy-cli` or set `default_provider: agy-cli` in EXTEND.md.
- Choose this provider when:
  - The user has an Antigravity subscription and explicitly does not want to manage a separate image API key.
  - The task needs a character/subject held visually consistent across multiple generations (avatar, digital human, recurring comic character): pass a prior generation as `--ref` and it reliably preserves face/hair/outfit without redescribing them in the prompt.
- Avoid this provider when latency matters — agy is an agent cold-start + reasoning workflow, typically much slower than direct API calls (except on cache hits).

## Supported flags

| Flag | Behavior |
|------|----------|
| `--prompt <text>` / `--promptfiles <files>` | Required. Written to a temp file and passed to the wrapper as `--prompt-file`. |
| `--image <path>` | Required. Final output location. **Bytes are JPEG** — keep a `.jpg`/`.jpeg` extension; `generate_image` always writes JPEG regardless of the internal name it was asked to use. |
| `--ar <ratio>` | Mapped to wrapper's `--aspect`. Supported: `1:1` (default), `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`. No `2.35:1` (unlike codex-cli). |
| `--ref <files...>` | Mapped to wrapper's repeated `--ref`, max 3. Forwarded into `generate_image`'s `ImagePaths` argument — verified to hold character/subject consistency across generations. |
| `--n` | Must be `1`. `validateArgs` throws if `n > 1` because `generate_image` returns a single image per call. |
| `--imageApiDialect` | Not applicable. Throws if set to a non-default value. |
| `--size`, `--imageSize`, `--quality` | Silently ignored — agy picks pixel dimensions from the aspect ratio. |
| `--model`, `-m` | Forwarded to `agy --model`. Default: `gemini-3.7-flash-medium`. Other valid values come from `agy models` (e.g. `claude-sonnet-4-6`, `gemini-3.1-pro-high`) — all expose `generate_image`, model choice affects reasoning quality/cost, not tool availability. |

## Environment variables

| Variable | Effect |
|----------|--------|
| `BAOYU_AGY_IMAGEGEN_BIN` | Override the wrapper path. Default: bundled `scripts/agy-imagegen/main.ts` resolved relative to this skill's installed location. Accepts a `.ts` file (spawned with `bun`) or a legacy `.sh`/binary (spawned directly). |
| `BAOYU_AGY_IMAGEGEN_CACHE_DIR` | Enable the wrapper's idempotency cache. Disabled by default; set to e.g. `~/.cache/baoyu-agy-imagegen` for high-value reuse. |
| `BAOYU_AGY_IMAGEGEN_TIMEOUT_MS` | Per-attempt `agy` timeout in ms. Default: `300000` (5 min). Raise for slow networks or large prompts. |
| `BAOYU_AGY_IMAGEGEN_RETRIES` | Wrapper-side retry attempts on retryable errors. Default: `2` (3 total attempts). |
| `BAOYU_AGY_IMAGEGEN_LOG_FILE` | Append a structured JSONL diagnostic log. Useful when triaging timeouts or `agent_refused` errors. |
| `BAOYU_IMAGE_GEN_AGY_CLI_CONCURRENCY` | Batch-mode concurrency for the `agy-cli` provider. Default: `1` — each call is a heavy single-process workflow; raising this rarely helps. |
| `BAOYU_IMAGE_GEN_AGY_CLI_START_INTERVAL_MS` | Batch-mode minimum start-gap. Default: `2000` ms. |

## Error model

The wrapper emits a single JSON line on stdout. On failure:

```json
{"status":"error","path":"...","bytes":0,"error":"...","error_kind":"..."}
```

The provider re-throws each wrapper error as `Invalid agy-cli result (<error_kind>): <message>`. The `"Invalid "` prefix triggers `isRetryableGenerationError` to mark it **non-retryable** in baoyu-image-gen's outer retry loop — the wrapper has already retried internally per `BAOYU_AGY_IMAGEGEN_RETRIES`, so re-spawning agy from main.ts would only multiply latency without changing the outcome.

**One exception:** when `error_kind` is `agent_refused` and the wrapper's `error` text matches a rate limit (`RESOURCE_EXHAUSTED`, `429`, `rate limit`, or `quota ... exceed`), the provider drops the `"Invalid "` prefix — e.g. `agy-cli rate limited (agent_refused): <message>` — so the message flows into the outer retry loop and `global-queue.ts`'s 429 cooldown instead of failing outright. A rate limit here is agy's **own Antigravity account quota** on its underlying model (e.g. `cloudcode-pa.googleapis.com` / `gemini-3.1-flash-image`, seen with a short `quotaResetDelay` of a few seconds) — a completely different pool from any Vertex/OpenAI quota baoyu-image-gen manages itself, so it is worth letting the outer machinery wait and retry rather than treating it as a hard content refusal.

For `status != SUCCESS`, the wrapper's error message now always includes agy's raw `error` field (when present), not just the frequently-empty-or-placeholder (`"OK"`) `response` field — so a failure is diagnosable from the reported message alone, without needing to re-run `agy` by hand to see what actually happened.

`error_kind` values to expect:

| Kind | Cause | Action |
|------|-------|--------|
| `agy_not_installed` | `agy` not on `PATH` or unreadable | Install Antigravity CLI, then confirm `agy models` works. |
| `invalid_args` | Programmer error in the spawn invocation, or bad `--aspect`/`--ref` count | Inspect provider source; usually a validation guard fired. |
| `prompt_file_missing` | Temp prompt file vanished mid-call | Retry once; check `$TMPDIR` permissions. |
| `spawn_failed` | OS / process-launch failure | Verify `bun` or `npx` is installed; check filesystem permissions. |
| `timeout` | `agy` exceeded `--timeout` | Raise `BAOYU_AGY_IMAGEGEN_TIMEOUT_MS`; check network. |
| `no_image_gen_tool_use` | Agent answered without calling `generate_image`, or the saved-file path couldn't be located in the transcript | Often transient — retry. If persistent, refine the prompt. |
| `output_missing` | Transcript said a file was saved but it's gone on disk | Retry; check disk space. |
| `invalid_jpeg` | Agent reported success but the file is absent or not a valid JPEG/PNG | Retry; check disk space. |
| `agent_refused` | agy reported a non-`SUCCESS` status, or produced no `conversation_id`. Message now includes agy's raw `error` field — check it first: if it's a 429/`RESOURCE_EXHAUSTED` from agy's own quota (see above), this is retried automatically by the outer loop; otherwise it's a genuine refusal — adjust the prompt or surface it to the user. | Read the `error` text before assuming it's a content refusal; adjust the prompt or surface it to the user if it isn't a rate limit. |
| `malformed_json` | agy's `--output-format json` stdout couldn't be parsed even after control-character sanitization | Retry; if persistent, file an issue with the raw log. |

## Trade-offs

- Slow: agent cold-start + reasoning before the tool call, except on cache hits.
- Subject to the same TOS as interactive `agy` use — programmatic invocation from baoyu-image-gen is the same usage class.
- Stateful: requires an active `agy` login; an expired session manifests as `agy_not_installed` or `agent_refused`.
- Output is JPEG, not PNG — if the caller explicitly requested a `.png` path, the file will contain JPEG bytes under a `.png` name (the wrapper does not transcode).

