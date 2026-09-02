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

**One exception:** when the wrapper reports a rate limit — either `error_kind` is the dedicated `quota_exhausted` (see below), or `error_kind` is `agent_refused` with `error` text matching `RESOURCE_EXHAUSTED` / `429` / `rate limit` / `quota ... exceed` — the provider drops the `"Invalid "` prefix — e.g. `agy-cli rate limited (quota_exhausted): <message>` — so the message flows into the outer retry loop and `global-queue.ts`'s 429 cooldown instead of failing outright. A rate limit here is agy's **own Antigravity account quota** on its underlying model (e.g. `cloudcode-pa.googleapis.com` / `gemini-3.1-flash-image`, seen with a short `quotaResetDelay` of a few seconds) — a completely different pool from any Vertex/OpenAI quota baoyu-image-gen manages itself, so it is worth letting the outer machinery wait and retry rather than treating it as a hard content refusal.

### How the saved file is located

Current Antigravity CLI transcripts (`brain/<conversation_id>/.system_generated/logs/transcript.jsonl`) no longer contain a `GENERATE_IMAGE` step or any "saved at `<path>`" text — the `generate_image` call now shows up as a `generate_image` `tool_call` on a `PLANNER_RESPONSE` step, and the timing/`GENERIC` step that follows carries no path. So the wrapper finds the output by **scanning this run's own `brain/<conversation_id>/` directory** (non-recursive — the `.system_generated` / `.user_uploaded` / `scratch` subdirs are skipped) for a file named `agy_imagegen_output*.{jpg,jpeg,png}` and taking the newest by mtime. This is inside the run's brain dir by construction, so it is a tighter security boundary than parsing a model-controlled path string. The old "saved at `<path>`" transcript scan is kept as a **fallback** for older agy installs and is tried first; when it hits, the extracted path is still resolved against `brain/<conversation_id>/` and rejected if it escapes.

A non-`SUCCESS` `status` from agy is **not** treated as an automatic failure. agy has been observed reporting `status: "ERROR"` (typically an internal 429 `RESOURCE_EXHAUSTED` while agy itself calls its upstream image backend) even though `generate_image` already ran and the image was actually saved to disk. So the wrapper always attempts its transcript+file verification first (confirm `generate_image` was invoked, locate the saved file per the section above, confirm the file is a real JPEG/PNG) regardless of `status` — the same check a `SUCCESS` status goes through. If that verification succeeds, the run is reported as `status: "ok"` and the recovered image is copied through normally (the wrapper logs a `status_error_but_recovered` JSONL event internally, visible via `BAOYU_AGY_IMAGEGEN_LOG_FILE`, so these false negatives from agy's own status field can be counted). Only when verification itself fails — no `generate_image` call in the transcript, no output file in the brain dir, or no `conversation_id` was returned — does the wrapper report a real failure. If a transcript step carries a quota/429 diagnostic in that case, the failure is reported as `quota_exhausted` rather than `no_image_gen_tool_use`. Either way the error message now always includes agy's raw `error` field (when present), not just the frequently-empty-or-placeholder (`"OK"`) `response` field — so a genuine failure is diagnosable from the reported message alone, without needing to re-run `agy` by hand to see what actually happened.

`error_kind` values to expect:

| Kind | Cause | Action |
|------|-------|--------|
| `agy_not_installed` | `agy` not on `PATH` or unreadable | Install Antigravity CLI, then confirm `agy models` works. |
| `invalid_args` | Programmer error in the spawn invocation, or bad `--aspect`/`--ref` count | Inspect provider source; usually a validation guard fired. |
| `prompt_file_missing` | Temp prompt file vanished mid-call | Retry once; check `$TMPDIR` permissions. |
| `spawn_failed` | OS / process-launch failure | Verify `bun` or `npx` is installed; check filesystem permissions. |
| `timeout` | `agy` exceeded `--timeout` | Raise `BAOYU_AGY_IMAGEGEN_TIMEOUT_MS`; check network. |
| `no_image_gen_tool_use` | `generate_image` was not invoked at all, **or** it ran but produced no output file in the run's `brain/<conversation_id>/` dir and no transcript step carried a quota/429 diagnostic. The message lists what the brain dir does contain. | Often transient — retry. If persistent, refine the prompt. |
| `quota_exhausted` | `generate_image` was invoked, produced no output file, and a transcript step (`PLANNER_RESPONSE` / `ERROR_MESSAGE`) carried a `RESOURCE_EXHAUSTED` / `QUOTA_EXHAUSTED` / `429` diagnostic — i.e. agy's own upstream image quota is spent. Retryable with backoff (agy's quota resets on a short delay); the provider routes it into the rate-limit path (`agy-cli rate limited (quota_exhausted): ...`) so `global-queue.ts`'s 429 cooldown applies. | Let the outer retry/cooldown handle it. If it persists across the cooldown, agy's account quota is genuinely exhausted — wait longer or switch provider/model. |
| `output_missing` | The located saved file is gone on disk by the time it's read | Retry; check disk space. |
| `invalid_jpeg` | Agent reported success but the file is absent, too small, or not a valid JPEG/PNG (magic-byte mismatch) | Retry; check disk space. |
| `agent_refused` | agy reported a non-`SUCCESS` status **and** transcript+file verification could not recover an actual saved image (or agy produced no `conversation_id` at all). Message includes agy's raw `error` field — check it first: if it's a 429/`RESOURCE_EXHAUSTED` from agy's own quota (see above), this is retried automatically by the outer loop; otherwise it's a genuine refusal — adjust the prompt or surface it to the user. Note: a non-`SUCCESS` status alone does **not** produce this error if verification finds the image was actually generated — see the ERROR-status recovery note above. | Read the `error` text before assuming it's a content refusal; adjust the prompt or surface it to the user if it isn't a rate limit. |
| `malformed_json` | agy's `--output-format json` stdout couldn't be parsed even after control-character sanitization | Retry; if persistent, file an issue with the raw log. |

## Trade-offs

- Slow: agent cold-start + reasoning before the tool call, except on cache hits.
- Subject to the same TOS as interactive `agy` use — programmatic invocation from baoyu-image-gen is the same usage class.
- Stateful: requires an active `agy` login; an expired session manifests as `agy_not_installed` or `agent_refused`.
- Output is JPEG, not PNG — if the caller explicitly requested a `.png` path, the file will contain JPEG bytes under a `.png` name (the wrapper does not transcode).

