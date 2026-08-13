# Fork synchronization

## Upstream changes

This is xasxcy's `baoyu-skills` fork. Before any upstream update, run `git fetch upstream --prune`, inspect the merge-base and the incoming diff, then selectively integrate the required provider changes. Preserve this fork's `baoyu-image-gen` compatibility path and its Vertex/global-queue, DashScope Qwen-ref, and SiliconFlow changes; do not directly merge or overwrite them with upstream's `baoyu-imagine` migration. See `CLAUDE.md` for the full repository guidance.
