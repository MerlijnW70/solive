# Job: Finish the find_jobs redesign (N5)

`find_jobs` now lists a job before its spec is read, marked `spec_checked: false`. A review of that change passed it and left these items.

## Build

1. **True words.** The tool description still says it lists jobs "whose spec this server can read". The `spec_url` field's description says "where the owner published the spec, or null", but null now also means not looked up yet. Make both true, in `packages/cli/src/agent/jobs.ts`, within the text limits the tests set, and regenerate the tool reference.
2. **Sealed jobs listed to the wrong wallet.** A job sealed to another wallet whose read takes longer than the head start is listed, unchecked, to a wallet that cannot open it, until a later call hides it. Say plainly in the unchecked hint that such a job may turn out not to be for this wallet. Check whether a cheap signal already read during listing could hide it sooner without a new network read, and use it if so.
3. **Close stops requests.** After the server closes, node requests already running and the transport's 429 backoff go on until their own timeout, keeping the process alive (`packages/cli/src/job-reads.ts`, the guarded transport races only running requests). Pass the closing signal into the requests and the backoff, as the `stop` argument of `limitedTransport` allows, so the process exits promptly. A send started by another tool must never be cut by this close.
4. **Test gaps.** A test that kills the mutant changing `left <= 0` to `left < 0` in the head start (`packages/cli/src/job-pages.ts`), and a test that `all: true` reads each escrow's history once over a whole page.

## Tests

Each item has a test that fails if its behaviour breaks, with kill timeouts on every run. Item 3 shows the time from close to exit with a request that never answers, before and after.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed, files under about 500 lines.
- No program change. Additions only to public exports and tool outputs, apart from the wording above.
- Do not touch `packages/cli/src/agent/settle.ts`, `create.ts`, `spec.ts`, `wallet/escrow.ts`, `faucet.ts`, `wallet.ts` or `flow-commands.ts`; another job is changing them.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names.
2. A review finds every item implemented and tested.

## Deliver

One `git format-patch` file. Announce its sha256 to the judge.
