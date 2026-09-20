# ChatGPT Web via opencli (`--provider chatgpt-web`)

Read when the user picks `--provider chatgpt-web`, sets `default_provider: chatgpt-web`, or wants to generate images against their **ChatGPT web image allowance** instead of an API key or the Codex subscription pool. This provider is a thin wrapper around `opencli chatgpt image`, which drives the logged-in ChatGPT web UI in the user's Chrome through the OpenCLI Browser Bridge extension. There is no bundled wrapper tree: opencli is the wrapper.

## Prerequisites

```bash
opencli --version                 # >= 1.8.7 recommended
opencli doctor                    # daemon + extension must be connected
opencli profile list              # find the Chrome profile logged into ChatGPT
opencli --profile <alias> chatgpt whoami
```

If more than one Chrome profile is connected, set `BAOYU_CHATGPT_WEB_PROFILE=<alias>` to the one logged into ChatGPT. The provider passes it as the global `--profile` option (it must precede the `chatgpt` subcommand).

## Selection

- **Never auto-selected.** Pin it with `--provider chatgpt-web` or `default_provider: chatgpt-web` in EXTEND.md.
- Choose it when the web image allowance is the intended quota pool, or when identity-locked digital-human work already lives in ChatGPT and you want the same account.
- Avoid it for batch throughput: one shared browser session, concurrency is fixed at 1, and each call takes roughly 40-90 s.

## Supported flags

| Flag | Behavior |
|------|----------|
| `--prompt <text>` / `--promptfiles <files>` | Required. Sent as the ChatGPT message. A prompt starting with `-` is prefixed with a newline so opencli does not read it as a flag. |
| `--image <path>` | Required. Output is PNG bytes; keep a `.png` extension. |
| `--ref <files...>` | Attached in the given order via `opencli --image a,b,c`, max 5. State each reference's role in the prompt ("image 1 is the primary face..."). |
| `--ar <ratio>` | No native flag; appended to the prompt as `Aspect ratio: <ratio>.` (a hint the model may or may not honor exactly). |
| `--n` | Must be `1`. |
| `--size` | Rejected: the web UI picks the canvas. |
| `--imageApiDialect` | Not applicable. Throws on a non-default value. |
| `--quality`, `--imageSize` | Ignored. |
| `--model`, `-m` | Not selectable. Only the label `chatgpt-web` is accepted. |

## Environment variables

| Variable | Effect |
|----------|--------|
| `BAOYU_CHATGPT_WEB_PROFILE` | opencli Browser Bridge profile alias (the profile logged into ChatGPT). Unset uses opencli's default profile. |
| `BAOYU_CHATGPT_WEB_BIN` | opencli binary path. Default: `opencli` on `PATH`. |
| `BAOYU_CHATGPT_WEB_TIMEOUT_MS` | Per-attempt timeout in ms, passed to opencli as `--timeout` (seconds). Default `240000`. The process is killed 30 s after that. |
| `BAOYU_IMAGE_GEN_CHATGPT_WEB_CONCURRENCY` | Batch concurrency. Default `1`; raising it makes runs collide on the single `site:chatgpt` session. |

## Error model

Every failure is thrown as `Invalid chatgpt-web result (exit <n>, <CODE>): <message>` (or `Invalid chatgpt-web setup: ...`). The `Invalid ` prefix makes `isRetryableGenerationError` treat it as **non-retryable**. This is deliberate: a dropped browser connection or a timeout can happen after the prompt was already submitted, and a blind retry would spend a second image of the web quota. Check the ChatGPT conversation list (`opencli chatgpt history`) before retrying by hand.

| Code | Cause | Action |
|------|-------|--------|
| `SESSION_BUSY` | Another opencli ChatGPT command holds `site:chatgpt` | Wait for it or stop it. |
| `COMMAND_EXEC` | Upload, send or download step failed (message says which) | Read the message; see Troubleshooting. |
| `UNKNOWN` | e.g. "Browser connection dropped after the navigate command was dispatched; it may have completed" | Look in `opencli chatgpt history` first. |
| `Invalid chatgpt-web setup` | `opencli` not found | Install `@jackwener/opencli` or set `BAOYU_CHATGPT_WEB_BIN`. |

## Troubleshooting

**`Failed to upload image ... Page.fileChooserOpened not received within 5s`** (observed with opencli 1.8.7 and Browser Bridge 1.0.24). ChatGPT's composer now exposes several `input[type=file]` elements and the extension's file-chooser path times out. The adapter has a working fallback that injects the files through a `DataTransfer` object on the input, but it only takes that path for a fixed list of error messages. Add `fileChooserOpened` to that list in the installed adapter:

```
<npm root -g>/@jackwener/opencli/clis/chatgpt/utils.js   (function uploadChatGPTImages)
-  ... && !msg.includes('No element found')) {
+  ... && !msg.includes('No element found') && !msg.includes('fileChooserOpened')) {
```

This is a local patch to a global npm package: an `npm i -g @jackwener/opencli` upgrade overwrites it, so re-apply after upgrading (or check that the upstream adapter no longer needs it). Text-only generation is unaffected.

**Two Chrome profiles connected and `opencli doctor` reports a connectivity failure.** Pass `--profile` (this provider does it for you when `BAOYU_CHATGPT_WEB_PROFILE` is set) or run `opencli profile use <alias>`.

## Trade-offs

- Automating the ChatGPT web UI is not an official API. OpenAI's terms restrict automated output extraction, so this may violate account terms; the user accepts that risk by choosing this provider.
- Fragile by nature: a ChatGPT front-end change can break the adapter until opencli ships a fix (`opencli` has a trace/autofix flow: rerun with `--trace retain-on-failure`).
- Content moderation on the web UI differs from the API and from Vertex; a face/portrait prompt can be refused. A refusal returns an error, not a retry.
- The single browser session serializes all calls; no parallelism.
