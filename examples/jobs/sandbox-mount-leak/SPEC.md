# Job: A judge sandbox run leaves no mount behind (I1)

**Rule:** after a judge sandbox run ends, by pass, fail, timeout, crash or interrupt, the Docker host has no more mounts than it had before the run.

On the dev host, the Docker Desktop VM reached its mount limit with about 75,000 leftover bind mounts under `/mnt/wsl/docker-desktop-bind-mounts/<distro>/<hash>`. After that, every `docker run` failed with `no space left on device` (exit 125), and every Docker-backed judge test failed with exit 75. The mounts come from the judge's `--mount type=bind` sources (`packages/cli/src/sandbox.ts` and the other callers listed below). These run on every judge and in the test suite.

## Build

1. **Root cause.** Find which bind mounts stay behind, and why. Candidates:
   - a source directory is removed while the container still holds it;
   - containers are not removed (`--rm` missing on some path, or the run is killed before removal);
   - Docker Desktop keeps a mount per distinct source path.

   Show the cause with a measured before/after mount count from a real run.
2. **Find every caller.** Search the whole repo for every place that starts a container with a bind mount or volume. Check at least these files under `packages/cli/src`: `sandbox.ts`, `node-judge.ts`, `container-check.ts`, `check-process.ts`, `artifact.ts`, `sandbox-doctor.ts`, and the test helpers. List each caller.
3. **Fix.** Make every run release its mounts on every exit path, including timeout, crash and SIGINT. Reuse one cleanup path. Do not weaken isolation: keep the mounts read-only and the sandbox flags as they are.
4. **Guard.** Add a test that counts the host's bind mounts before and after a batch of sandbox runs, covering pass, fail, timeout and interrupt. The count must not grow. Skip it with a clear reason when Docker is not available.

   Also add a check to `sandbox-doctor` that warns when the mount count is near the limit.

## Tests

- The mount-count test fails without the fix and passes with it.
- Each exit path is covered.
- The existing judge sandbox tests still pass.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- Only the files named here, the callers found in item 2, their tests and the generated references. No program change.
- Run the full test suite of each package you change, plus typecheck, lint and the docs checks. The judge runs the full CI.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review confirms the root cause from the measurement, every caller is covered, and isolation is unchanged.

## Deliver

One `git format-patch` file with the measurement. Announce its sha256 to the judge.
