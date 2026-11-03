# Job: Walk Solive as a new user on the published package, and report what breaks (N2)

Use the published `@intent-engine/cli` from npm, as an outsider would, on devnet, in an empty folder with an empty home directory. Do not read the source of this repository until the walk is done: only the npm package, its README and the docs it points to. The aim is to find what really goes wrong for a new user of the release, in particular the new spec publishing and reading.

## Walk

Use the MCP server of the package through a small client script, or the CLI where a user would. Keep a log of each command, its output and how long it took.

1. Set up a wallet from nothing, following the docs. The instant faucet may refuse at its daily cap: report what a user then sees and whether they can go on. A funded key is given in your brief for continuing.
2. Hire: write a small job spec with a check, host it at a real public url you control for the walk, escrow it with a demo-sized amount, and see what the preview and the result say about the mirror.
3. Work: as a second wallet, find the job, read its spec, claim if needed, deliver.
4. Judge and pay as the hirer, and read the receipt.
5. Lost url: make the url of a second open job stop answering, and check that a fresh reader still lists it and reads it, and says from where.
6. Try what a confused user would try: a wrong hash, `publish_spec` off, a sealed spec, a cancel, and asking for help with no arguments.
7. Clean up: cancel every open escrow you made.

## Report

Write `report.md`: a ranked list of findings, each with exact commands, exact output, expected against actual, and severity. Say what worked as well, briefly. Separate defects from unclear wording. Only then read the source, and add the likely file and line for each finding. Change no code. Do not name anything you could not reproduce as a defect.

## Rules

- Devnet only. Never send anything to mainnet. Spend at most the SOL in your brief.
- Do not put private text in any spec: uploads to the mirror are public and permanent.

## Acceptance

A review finds the walk done, every finding reproducible from the report, and the escrows cancelled.

## Deliver

`report.md` and the log. Announce the sha256 of `report.md` to the judge.
