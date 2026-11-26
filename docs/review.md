# Require a signed review

A [pinned check](judge.md#pin-the-check-in-the-spec) can pass work that a person would fail. This page adds named reviewers to the bar: a judge pays only on their signed review of the exact work.

## The block

A hirer who wants named reviewers to approve each payment adds one block fenced as `judge-review`:

````markdown
```judge-review
{"reviewers": ["<reviewer wallet>", "<reviewer wallet>"], "threshold": 2}
```
````

`reviewers` lists 1 to 16 distinct wallets. `threshold` is how many of them must sign, from 1 to their number; left out, every reviewer must sign. The block sits beside `judge-run` or `judge-cases`, and follows the same fence rules. Reviewers and threshold come only from the pinned spec, never from a review file or an option.

Each reviewer signs a review of the delivered work with their own key file:

```sh
intent-engine review --keypair reviewer.json --owner $OWNER --nonce $NONCE --artifact work --outcome pay --reason "read the code and reran the gates" --out review.json --yes
```

In PowerShell:

```powershell
intent-engine review --keypair reviewer.json --owner $env:OWNER --nonce $env:NONCE --artifact work --outcome pay --reason "read the code and reran the gates" --out review.json --yes
```

The review signs the cluster, the escrow, its nonce, the spec's sha256, the work's sha256, the outcome `pay` or `fail` and the reason, up to 200 characters. A second reviewer adds a signature with `review --keypair other.json --add review.json --out review.json --yes`. Over MCP, `solive_wallet_review`, served with `mcp --wallet --all-tools`, signs the same review and returns its file.

The judge passes every review file with `--review`, with or without `--watch`:

```sh
intent-engine judge --owner $OWNER --nonce $NONCE --spec spec.md --artifact work --run "true" --review review.json --verdict verdict.json --yes
```

In PowerShell:

```powershell
intent-engine judge --owner $env:OWNER --nonce $env:NONCE --spec spec.md --artifact work --run "true" --review review.json --verdict verdict.json --yes
```

`judge` runs the check only after the reviews pass: every file signs one statement, it binds this escrow, spec and work on this cluster, and it carries signatures of `threshold` named reviewers. A key outside the list does not count, and a reviewer who signed twice counts once. Anything else is refused with exit 78, and nothing runs or is paid; `--watch` tries that work again next round.

A `pay` review lets the check decide. A `fail` review fails the work without running the check, writes a fail receipt and so lets `reject` reject it. The verdict and the receipt record the review's `sha256` and `signers`. `--review` on a spec without the block is refused.

`solive_wallet_attest`, `solive_wallet_attest_split`, `committee vote` and `solive_wallet_committee_vote` read the spec from its url. When it has the block, they sign only with a receipt that records a review of `threshold` named reviewers. `--without-receipt` and `without_receipt` then need a reason that contains the words `review gate`, and the warning says the review gate was skipped.

The spec is read from the url its owner published. When none is published, the url now serves bytes with another sha256, a sealed spec cannot be opened or the read fails, the review gate is unknown. Then these tools sign nothing, not even with a receipt, unless `--without-receipt` or `without_receipt` gives a reason that contains the words `review gate`. The refusal says why the gate is unknown.

`judge` on a spec with the block saves a record of the escrow, the spec's sha256 and the reviewers on this machine. Later signatures here keep the review gate for that escrow, even when its url changes or goes away. `solive_wallet_judge_work` judges nothing for a spec with the block. `solive_get_spec` and `intent-engine spec` show the block as `judge_review`.

## Next

- [Judge work](judge.md)
