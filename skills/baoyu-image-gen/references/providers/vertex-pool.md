# Vertex AI multi-account / multi-project pool

`--provider vertex` normally targets a single GCP project (`VERTEX_PROJECT_ID` →
`GOOGLE_CLOUD_PROJECT` → `gcloud config get-value project`) using whichever
`gcloud` account is currently active. When you have several GCP accounts and/or
projects each with their own Vertex quota, configure a **pool** instead: the
provider will round-robin (or weight-random) across nodes, and transparently
fail over to the next healthy node on 429/5xx/network errors within the same
generation call — no retry-with-same-project loop, no manual account juggling.

## When to use this vs. a single project

- One GCP project, occasional 429s → the existing single-node retry (3
  attempts with backoff) already handles it. No pool needed.
- Several GCP accounts/projects, want to burn through quota faster or keep
  generating after one project is rate-limited → configure a pool.

## Configuration

Highest priority wins; unset → no pool (falls back to the single-node path
unchanged):

1. `VERTEX_POOL_CONFIG` — JSON array of nodes (env var)
2. `VERTEX_PROJECT_IDS` — comma-separated project ids, all sharing the
   currently-active `gcloud` account (env var, simpler than #1 when every
   project is reachable from one login)
3. `vertex_pool_config` in EXTEND.md — same JSON-array shape as #1, as a
   quoted string (the EXTEND.md parser only understands scalar values)

Node shape: `{ "id"?: string, "account"?: string, "project": string, "location"?: string, "weight"?: number }`.
`project` is the only required field. `id` defaults to
`${account ?? "default"}::${project}::${location}`. `location` defaults to
`"global"`. `weight` defaults to `1` (only used by `weighted-random` routing).

```bash
# Env var
export VERTEX_POOL_CONFIG='[
  {"account":"alice@example.com","project":"proj-a","location":"global"},
  {"account":"bob@example.com","project":"proj-b","location":"global"}
]'
${BUN_X} {baseDir}/scripts/main.ts --prompt "A cat" --image out.png --provider vertex --model gemini-3.1-flash-image
```

```yaml
# ~/.baoyu-skills/baoyu-image-gen/EXTEND.md
default_provider: vertex
default_model:
  vertex: gemini-3.1-flash-image
vertex_pool_config: '[{"account":"alice@example.com","project":"proj-a"},{"account":"bob@example.com","project":"proj-b"}]'
vertex_pool_routing: round-robin
vertex_pool_cooldown_seconds: 60
```

Simple form when every project is reachable from the account you're already
logged into (no `account` field needed):

```bash
export VERTEX_PROJECT_IDS="proj-a,proj-b,proj-c"
```

## Per-account tokens

For a node with `account` set, the provider runs
`CLOUDSDK_CORE_ACCOUNT=<account> gcloud auth print-access-token` — this mints a
token for that account **without changing your global `gcloud config`**
(verified: `gcloud config get-value account` is unaffected). Every account
used in the pool must already be logged in (`gcloud auth list`); the pool does
not run `gcloud auth login` for you.

Tokens are cached per account for ~45 minutes. The accountless single-node
path (no pool, or a pool node with no `account`) is **not** cached — it always
shells out, so switching your active `gcloud` account takes effect on the next
call, same as before pooling existed.

If `VERTEX_BEARER_TOKEN`/`GOOGLE_ACCESS_TOKEN` is set globally *and* a pool
node has an `account`, the provider refuses to run (ambiguous which
credential should apply) unless you set `VERTEX_POOL_ALLOW_STATIC_TOKEN=1`,
which explicitly authorizes that one token for every configured project.

## Failover behavior

- On a transient error (HTTP 429/500/502/503/504, or a network-level failure)
  the node is put on cooldown (default 60s, taking the larger of that local
  value and any longer cooldown the shared queue has already recorded for
  that project) and the **next healthy node is tried in the same call** — the
  caller sees one slower-but-successful generation, not a failure.
- A permanent error (400/401/403/404, prompt rejection, etc.) does **not**
  fail over — retrying on a different project wouldn't help, so it's reported
  immediately.
- Each node is tried at most once per outer attempt; the existing 3-attempt /
  backoff retry loop wraps the whole pool, so a full cycle can retry after
  every node has failed once.
- If every node is cooling down, the call waits (bounded to a few minutes)
  for the earliest node to free up rather than failing immediately — same
  spirit as the existing global queue's cooldown wait, just pool-aware.
- Concurrent identical requests (same prompt/model/args/output) dedupe across
  the whole pool, not just within one project — two Hermes processes racing
  the same task won't both burn quota.

## Model names

Vertex publishes different model ids than the direct Gemini API. Verified via
the project-scoped model catalog:

- `gemini-3.1-flash-image` (pool default), `gemini-3-pro-image`,
  `gemini-3.1-flash-image-preview`, `gemini-3.1-flash-lite-image`
- `gemini-3-pro-image-preview` is **not** a Vertex model (it 404s) — that name
  only exists on the `google` (API-key) provider. Don't mix the two.

## Limitations

- Round-robin/weighted-random routing is **per-process**: each `bun main.ts`
  invocation starts its own cursor. Across many separate CLI invocations,
  load spreading in practice comes from the failover+cooldown mechanism
  (a project that 429s gets skipped process-wide via the shared queue state),
  not from an even round-robin split. Within one batch run (`--batchfile`,
  single process, many tasks) round-robin does spread requests evenly.
- Pool ownership is held for at most ~8 minutes while waiting for a healthy
  node, plus one in-flight request (bounded to 180s). Past roughly 20 minutes
  of sustained unavailability across every node, cross-process dedup
  degrades to the same best-effort behavior the non-pool path already has —
  not a regression, just not a stronger guarantee either.
