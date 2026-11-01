# Job: Do we need the old GitHub Actions runs?

The repository `MerlijnW70/solive` keeps every run of its workflows. The scheduled `monitor` and `faucet` workflows add a run every hour or more often. The runs crowd the Actions page. Find out which old runs, logs and artifacts the project needs, and recommend what to keep and for how long.

Research only. Do not delete, cancel or rerun anything, and change no setting or file. Read with the `gh` CLI and the repository files.

## Questions

1. **What each workflow is for.** For each file in `.github/workflows/`, state its triggers, what it checks or produces, and what a failed run means. Cite the file and line.
2. **Who reads old runs.** Find every place that reads past runs, logs or artifacts: workflows (for example `release.yml` looking up a successful `ci` run for its commit, or a job downloading an artifact), scripts, tests, docs and alerting. Name each one, the age of run it needs, and what breaks if that run is gone.
3. **What the monitor's history is worth.** Does anything compare a monitor run with earlier runs, or does each run stand alone against the committed baseline? Is a failed monitor run reported anywhere besides the Actions page (an issue, a notification)? How long must a failure stay visible for someone to act on it?
4. **What is stored today.** Count the runs per workflow and the artifacts, with their sizes and expiry. Read the repository's log and artifact retention setting if `gh` can read it; if it cannot, say so.
5. **What GitHub allows.** From GitHub's documentation, with links: retention settings for logs and artifacts, deleting runs through the API and its rate limits, whether deleting a run affects required checks on a commit, and anything else that reduces clutter, such as fewer scheduled runs or skipping work early.

## Deliver

`report.md` with:

- One short answer per question, with evidence: commands and their output, or file and line.
- A recommendation table: per workflow, which runs to keep (for example the last N, the last N days, or all failures) and why.
- The retention setting to use, if any.
- An exact, reversible-as-possible cleanup procedure the owner can run, with the commands. Mark anything that cannot be undone.
- What you could not verify.

Keep it terse: findings and evidence, no filler.

## Acceptance

1. Every question is answered with evidence the judge can check.
2. The judge spot-checks three claims against the repository and GitHub, and all three hold.
3. Nothing in the repository or its settings was changed.

## Deliver

Announce the sha256 of `report.md` to the judge.
