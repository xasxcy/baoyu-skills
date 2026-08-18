# `agy-imagegen` Wrapper Invocation

Load this reference only when the [Image Generation Tools](../SKILL.md#image-generation-tools) rule has resolved to `agy-imagegen` — i.e., the current runtime exposes no native `imagegen`/`GenerateImage` skill but the `agy` (Antigravity) CLI is on `PATH` and authenticated.

## Preferred path: route through `baoyu-image-gen`

If the `baoyu-image-gen` skill is available in this runtime, **always** invoke through it rather than calling the wrapper directly. It handles retry/cache/batch/EXTEND.md preferences uniformly with every other provider.

```bash
${BUN_X} <baoyu-image-gen-base>/scripts/main.ts \
  --provider agy-cli \
  --image <ABSOLUTE_output.jpg> \
  --promptfiles <ABSOLUTE_prompts/NN-{cover|page}-[slug].md> \
  --ar <ratio> \
  [--ref <ABSOLUTE_file>]...
```

Resolve `<baoyu-image-gen-base>` the same way you resolve any sibling skill — through your runtime's skill registry (`Skill` tool, plugin marketplace, or `$HOME/.baoyu-skills/baoyu-image-gen/`).

## Fallback: spawn the wrapper directly

Only when `baoyu-image-gen` is NOT installed in the current runtime. Discover the wrapper's location at runtime — do NOT hard-code `../../packages/...` from this skill:

1. **Honor explicit override**: if `$BAOYU_AGY_IMAGEGEN_BIN` is set and points to a real file, use that path. It may be `.ts` (spawn `bun <path>`) or `.sh`/binary (spawn directly).
2. **Search the plugin root**: walk up from this skill's directory looking for `packages/baoyu-agy-imagegen/src/main.ts`. If found, that is the wrapper. Spawn it with `bun`.
3. **Last resort**: tell the user that `agy-imagegen` is not available in this runtime and ask whether to install the `baoyu-skills` plugin (or set `BAOYU_AGY_IMAGEGEN_BIN`) or pick another backend.

Once located, the invocation shape is:

```bash
bun <WRAPPER>/main.ts \
  --image <ABSOLUTE_output.jpg> \
  --prompt-file <ABSOLUTE_prompts/NN-{cover|page}-[slug].md> \
  --aspect <ratio> \
  [--ref <ABSOLUTE_file>]... \
  [--timeout <ms>] \
  [--cache-dir ~/.cache/baoyu-agy-imagegen] \
  [--log-file <ABSOLUTE_jsonl_log_path>]
```

If `bun` is missing, `npx -y bun <WRAPPER>/main.ts ...` works as a fallback.

## Parameter notes

- **Output is JPEG, not PNG.** `agy`'s `generate_image` tool always writes a `.jpg` file regardless of the requested internal name. Keep a `.jpg`/`.jpeg` extension on `--image`; the wrapper copies bytes verbatim without transcoding.
- **All filesystem inputs** are auto-resolved against `process.cwd()` when relative, but agents should pass absolute paths to be robust against cwd drift.
- **`--ref` (up to 3 images)** holds character appearance across pages reliably — pass a character sheet or a prior page as `--ref` and the prompt does not need to redescribe hair/outfit/face details.
- **`--timeout`** defaults to `300000` (5 min) per `agy` attempt. Raise (e.g. `--timeout 600000` for 10 min) on slow networks or large prompts.
- **`--cache-dir`** is off by default. Enable for repeatable runs to skip redundant generations of the same prompt+aspect+model+refs.
- **Authentication**: the wrapper uses the user's Antigravity subscription — no separate image API key is read or sent.

## Stdout contract

Single JSON line:

- Success: `{"status":"ok","path":"...","bytes":N,"elapsed_seconds":N,"conversation_id":"...","attempts":N,"cached":bool,...}`
- Failure: `{"status":"error","path":"...","bytes":0,"error":"...","error_kind":"..."}`

`error_kind` values: `agy_not_installed`, `invalid_args`, `prompt_file_missing`, `spawn_failed`, `timeout`, `no_image_gen_tool_use`, `output_missing`, `invalid_jpeg`, `agent_refused`, `malformed_json`.

On retryable errors (timeout, spawn_failed, no_image_gen_tool_use, output_missing, invalid_jpeg, agent_refused, malformed_json), ask the user whether to retry or fall back to another backend.

## Batch semantics

- `generate_image` returns **one image per call** (`n=1` only). Multi-image jobs must dispatch one wrapper call per page.
- The wrapper does NOT accept a `--sessionId` flag. Chain/scene consistency must come from `--ref` reference images.
- `--size` and `--quality` are silently ignored — pick from the 7 supported `--aspect` values (`1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`); agy picks pixel dimensions from that.
