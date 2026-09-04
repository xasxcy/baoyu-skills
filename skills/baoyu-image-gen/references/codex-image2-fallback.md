---
name: codex-image2-fallback
description: Fallback behavior when baoyu-image-gen lacks OpenAI API credentials but Codex/native image generation is available
---

# Codex Image2 Fallback

When using `baoyu-image-gen` with `--provider openai --model gpt-image-2`, the CLI can fail with:

```text
OPENAI_API_KEY is required. Codex/ChatGPT desktop login does not automatically grant OpenAI Images API access to this script.
```

This is expected. The `openai` provider uses the public OpenAI Images API and needs `OPENAI_API_KEY`. Codex / ChatGPT image2 entitlement is a separate runtime-native path.

## Practical fallback pattern

Switching to a different backend moves the prompt and any reference images to another service and bills a different account/subscription, so it needs the user's authorization — the same sticky-on-failure rule as `default_provider` in SKILL.md's Provider Selection. Do **not** switch automatically.

1. Try `baoyu-image-gen` when provider credentials are available.
2. If it fails only because `OPENAI_API_KEY` is missing:
   - If the user already selected a native/Codex path (`--provider codex-cli`, `default_provider: codex-cli`, or an explicit request for the runtime-native image tool), use that — it is their stated choice. Skip to step 4.
   - Otherwise, **stop and surface the error.** Tell the user `OPENAI_API_KEY` is missing and name the available alternative(s) (see step 3). Proceed only after they confirm a specific one.
3. Alternatives to offer (do not invoke without confirmation per step 2):
   - Codex runtime native `imagegen` skill/tool, if available.
   - `baoyu-image-gen --provider codex-cli` (wraps the bundled `scripts/codex-imagegen/main.ts`; the underlying repo-level package lives at `packages/baoyu-codex-imagegen/src/main.ts` for standalone callers), if `codex` CLI is installed/logged in. Uses the user's own Codex subscription.
   - Hermes native `image_generate`, if available.
4. Once a backend is authorized, be transparent about reference-image behavior:
   - If it accepts references, pass the reference images.
   - If it does not, derive a concise identity-preserving prompt from the references and state that it is a text-description fallback, not strict reference-image editing.
5. Return the generated media path or structured backend error promptly.

## User-facing wording

When `OPENAI_API_KEY` is missing and no native/Codex path was pre-selected, ask before switching:

> The OpenAI API path needs `OPENAI_API_KEY`, which isn't set. I can instead use [the runtime-native image tool / `--provider codex-cli`, which uses your Codex subscription] — that sends the prompt and any reference images to a different service. Want me to do that?

After the user confirms (or if they had already selected that path):

> Used [the Codex/native image backend] instead of the OpenAI API. Reference images were [passed directly / reconstructed from visual traits].

Avoid implying that `baoyu-image-gen --provider openai` can use Codex OAuth without a dedicated provider implementation.
