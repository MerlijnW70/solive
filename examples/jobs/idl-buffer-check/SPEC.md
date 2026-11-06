# Job: The IDL update hands over only a complete buffer (idl-buffer-check)

**Rule:** `scripts/idl.sh` never hands a buffer to the multisig vault, or uses it for a direct write, unless the buffer's decoded content equals `idl/intent_engine.json`. A buffer that fails the check stays under the local key, and the script closes it and says so.

On 2026-11-06 a devnet IDL update with `--multisig` hit rate limits (HTTP 429) while `create-buffer` wrote. `create-buffer` reported success, but the buffer held only part of the compressed IDL. `idl.sh` then set the vault as the buffer's authority. The multisig review refused to propose it, because the data did not decode. But the buffer already belonged to the vault, so closing it took a separate proposal. A second try passed once `fetch-buffer` was compared with the IDL before the handover.

## Build

1. In the `--multisig` path, after `create-buffer` and before `set-buffer-authority`: fetch the buffer, decode it, and compare it with `idl/intent_engine.json` as parsed JSON. On a mismatch or a failed fetch, close the buffer with the local key, print what happened, and exit non-zero.
2. Apply the same rule to every other path in `scripts/idl.sh` that writes or uses a buffer. List each path in the report.
3. Keep the script's other refusals and outputs as they are.

## Tests

- A test with a fake `program-metadata` command that writes a truncated buffer. The script must refuse before any authority change, must call the close, and must exit non-zero.
- A test that a complete buffer is handed over as today.
- Use the repository's existing pattern for testing shell scripts, if one exists. Otherwise add the smallest harness that `scripts/ci.sh` runs.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- No program change. Do not touch devnet or any real cluster.
- Rebase onto the latest local `main` of `F:\solive` right before delivering, and name the base commit.
- Never write to the shared git config, never export `GIT_DIR` or `GIT_WORK_TREE` around test runs, and never add a `Signed-off-by` line.
- Run lint and the tests you add.

## Report

- The changes, and how each path in `idl.sh` is covered.
- **Same defect elsewhere:** `path:line — why`, for example `scripts/deploy.sh` program buffers.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms that no buffer can reach the vault without the check.

## Deliver

One `git format-patch` file plus the report. Announce its sha256 to the judge.
