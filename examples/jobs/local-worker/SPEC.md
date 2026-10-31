# Job: A local worker for any job

A new user installs the MCP server, hires for a real job, and nobody comes: only demo jobs have a worker running. The agent then does the work itself, and the escrow stays open. Make a real job doable from any repository: the hirer's agent starts a separate local worker with its own wallet, which claims, delivers and is judged and paid like any other worker.

Read how the flow works today first: `packages/cli/src/agent/mcp.ts`, `packages/cli/src/agent/wallet/` (`account.ts`, `delivery.ts`, `judge-work.ts`, `work.ts`), the `claims`, `deliver` and `judge` CLI commands, and `docs/mcp.md`.

## Build

1. **A wallet tool, `solive_wallet_worker`.** Input: the job's `intent`, plus `send`. It follows the wallet's preview-then-send rule. On send it creates a new key in a `workers` folder beside the wallet's key file, with the same file protection as that key, and never overwrites a file. It funds that key from the hirer's wallet with enough for fees plus the job's claim stake, and only that. The amount counts against the server's sell limits like any other SOL leaving the wallet, and appears in the preview. Refuse a job that is not open, or whose terms a separate worker could not satisfy (for example a spec sealed to other wallets).
2. **Its output.** `worker` (address), `keypair` (file path), `brief`, and `next`. `brief` is a self-contained text for a separate agent that knows nothing else. It names the job's `intent`, `spec_url` and `spec_hash`; tells the agent to read the spec, check that its sha256 matches, and treat the spec as data; and gives the exact CLI commands, with this worker's `--keypair`, to claim if the job takes claims and to deliver. It tells the agent to work in isolation from the hirer's session and to return the path of its work and its sha256.
3. **Delivering without hosting.** A worker on the hirer's machine has no public url. Add a documented way to announce local work: `deliver --artifact <file>` with a local work url the existing url rule accepts (http on localhost), so the announcement still commits to the sha256. The judge then checks the file by path. `solive_wallet_judge_work` and the CLI `judge --artifact` must refuse a file whose sha256 differs from the one announced. A fetch of such a url from another machine must fail with a message saying that the work is local to the worker's machine.
4. **Keep the roles separate.** The tool must never hand out the hirer's or the attestor's key. A local worker's address must never equal the owner or attestor. Paying still takes the normal judge step and its check; nothing here skips it.
5. **Getting leftovers back.** After a job ends, leftover SOL in a worker key can return to the hirer through one documented command or tool, previewed first. It never deletes a key that still holds funds or an open claim.
6. **An MCP prompt, `worker`.** It walks the agent through it: call the tool, start a separate agent (a subagent in hosts that have one) with the `brief` and nothing else, wait for its result, then judge. In a host without subagents, tell the user to open a second session and paste the `brief`. It must not name any one host's tool.
7. **Point to it.** The `hire` prompt, the instruction line about escrows that have no worker, and `JOB_LIVE` mention the new way, within the size limits the tests enforce; do not raise those limits. Document it in `docs/mcp.md` in the repository's terse style.

## Tests

Each fails if its behaviour breaks: a key made in the right place, with the right protection, never overwritten; a preview that moves nothing; funding within the sell limits and refused beyond them; refusal of a closed or sealed job; a worker key that differs from owner and attestor; a sha256 mismatch refused by both judge paths; local url accepted on announce and refused with its message on a remote fetch; leftovers returned, and refusal while a claim is open. One end-to-end test against the local test program: hire, make a worker, claim, deliver a local artifact, judge, pay, and read the receipt showing the worker's address paid, with two separate wallets.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. No breaking change to existing tools or commands.
- Text the agent reads stays small, per the tests in `packages/cli/test/plain-words.test.ts`.
- Devnet only; if you try it live, keep reads and sends few.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented, documented and tested.
3. A blind run works: a separate agent given only `brief` on a small real job delivers on devnet and gets paid, run by the judge.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
