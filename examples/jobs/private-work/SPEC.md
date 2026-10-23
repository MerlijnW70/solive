# Job: Private work and safe fetching for agents

`docs/private-jobs.md` describes invite-only jobs: the spec is sealed to the invited workers and the judge, the worker seals its work to the judge, and the judge opens it. Since 0.1.48 an agent can seal a spec with `solive_wallet_seal_spec`, but the rest needs `intent-engine seal` and `unseal`, so an agent cannot finish a private job. In three devnet job chains every judge also downloaded announced work by hand with curl and sha256.

## Required

- A wallet tool seals a work file's bytes, given as text or base64, to an escrow's attestor, or to a committee's members when a committee judges, in the format `intent-engine unseal` opens, and returns the sealed text and the sha256 to announce with `wallet_deliver`. It sends nothing.
- A wallet tool fetches announced work for this wallet as judge: given the escrow and an announcement, it downloads the url sealed to this wallet with the same limits `solive_get_spec` uses (no redirects, a size cap, https only, private addresses refused), opens sealed work with this wallet's key, and returns the work's sha256, whether that sha256 opens the announcement's commitment, its size, and its text when it is valid UTF-8 within the cap, marked as untrusted. It sends nothing and runs nothing.
- `wallet_deliver`, `wallet_check_delivery` and `docs/private-jobs.md` name these tools next to the commands, and `docs/private-jobs.md` shows the whole private job with wallet tools only.
- Tests for each change; every changed text follows the repository's tool text rules and the served-tool check.

## Rules

- Follow `CONTRIBUTING.md`: no code comments, nothing bypassed. Only `packages/cli`, `packages/client` where a shared helper is needed, `docs/private-jobs.md`, and the generated references and docs the tests check. No program change. Do not change `wallet_claim`, `solive_get_claims`, `wallet_escrow`, `wallet_escrow_plan`, `solive_find_jobs` or the committee tools.
- Keep tool names and existing inputs as they are. Keep files under about 500 lines.

## Acceptance

1. `bash scripts/ci.sh` passes with the patch applied to `main` at the commit the delivery names, and the docs site still builds.
2. A test runs a whole invite-only job with wallet tools only: seal the spec, escrow it, the invited worker reads it, seals its work and announces it, the judge fetches and opens the work, checks that it opens the commitment, and releases; an uninvited wallet can open neither file.
3. A test shows the fetch tool refusing a redirect, a private address and a body over the cap.
4. A test fails when the judge makes the fetch tool skip the commitment check.

## Deliver

One `git format-patch` file at a public https url. Announce its sha256 to the judge.
