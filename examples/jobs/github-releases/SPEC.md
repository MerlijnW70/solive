# Job: A GitHub Release for every published version

The repository has version tags (`v0.1.77`) and `.github/workflows/release.yml` publishes them to npm, but no GitHub Release exists, so the repository page shows no current version.

## Build

1. After the npm publish in `release.yml` succeeds, create a GitHub Release for the tag, titled with the version, with short notes: the commit titles since the previous tag. Use only the `gh` CLI or the GitHub API with the workflow's token; give the job only the extra permission it needs (`contents: write` on that job, nothing wider).
2. A failure to create the release must not undo, retry or block the npm publish, and must not fail silently: the job reports it.
3. Re-running the workflow for a tag whose release exists does not create a second one.
4. Document it in `docs/maintainers/` in the repository's terse style.

## Tests

The workflow tests (`packages/cli/test/release.test.ts` and similar) check: the release step runs after the publish and only on success; it uses the tag as name; the permission is scoped to that job; a second run does not duplicate; the npm publish steps are unchanged.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed.
- Do not change how or when npm publishing happens, the gate, or trusted publishing.
- Pin any new action by full commit sha, like the existing ones.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds the publish path unchanged and the new step correct.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
