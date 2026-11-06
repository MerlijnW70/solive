# Server options

Ways to run `intent-engine mcp`, the server that [Use it from your AI](ai.md) adds.

With `--wallet` the server serves the everyday tools, the committee and profile tools among them, and its instructions end with an index of them by task. Add `--all-tools` to serve every tool, such as the read and unsigned-transaction tools.

## How a job works

A hirer locks payment in an escrow with `solive_wallet_escrow`, pinned to a spec by its sha256. A worker finds the job with `solive_find_jobs`, checks it with `solive_get_spec` and announces the work with `solive_wallet_deliver`. The judge is the escrow's attestor: the hirer's own wallet, another wallet, or a committee. It fetches the work with `solive_wallet_fetch_work`, runs the spec's check with `solive_wallet_judge_work` or the CLI command `judge`, and only on a pass pays with `solive_wallet_attest`, or, as a committee, votes with `solive_wallet_committee_vote`.

A signature needs a passing run. `solive_wallet_judge_work` and `judge` save a receipt on each pass, and `solive_wallet_attest`, `solive_wallet_attest_split` and `solive_wallet_committee_vote` sign for a proof escrow only with a matching one; otherwise they refuse with `NoJudgeReceipt`. `solive_wallet_committee_release` relays votes without a receipt, except a member's own co-author signature. The override is `without_receipt`, a non-empty reason: the output records it as `unchecked` with a warning, and the preview's `approval` binds it. See [Judge work](judge.md#a-signature-needs-a-passing-run).

The previews of `solive_wallet_attest` and `solive_wallet_attest_split` check each fee account the way the program does. `fee` counts the fees the release pays, the judge's included. `withheld` counts fees whose account cannot receive them, for example one that is frozen, has a CPI guard or now belongs to another owner. Those stay in the escrow and go to its owner when it closes. `fees` lists each fee, its account, and whether it is paid.

An escrow only offers a job. Only the demo jobs have a worker running, so any other job can stay undone and unpaid until a worker takes it, or until you start [a local worker](#a-local-worker).

The judge runs the check itself with [`judge`](judge.md): `--sandbox viper` checks a demo job, or one JavaScript module whose spec has a `judge-cases` block, without Docker, and `--sandbox docker` is for a spec that needs a container. A judge that can run neither approves nothing.

A hirer without a spec is offered a demo job, as [Your first hired agent](first-hire.md) shows. Every send costs SOL, and `solive_wallet_setup` asks the node for free SOL. The `--wallet` server's instructions say this under `How a job works:`.

`solive_wallet_setup` and `solive_wallet_balance` return an `explorer` link that opens your address on devnet. Devnet SOL shows only when your wallet app or explorer is switched to devnet.

When `solive_wallet_setup` returns too little SOL, `why` names the reason and `other_ways` lists the routes, fastest first. The first is to send devnet SOL to the wallet's address from any wallet app switched to devnet.

With `--wallet` the server also offers prompts. Each is one message that walks the AI through the tools in order, previews every send and asks before sending.

| Prompt | What it does |
| --- | --- |
| `start` | Sets up a test wallet and makes a first swap |
| `hire` | Writes a spec with a check, escrows it with a judge, then judges the delivery |
| `earn` | Finds a job whose spec matches, claims it, delivers and follows it to payment |
| `judge` | Fetches delivered work, runs the spec's check, then approves a pass or refuses |
| `worker` | Makes a separate local worker for a job, hands an agent its brief, then judges what it delivers |

## Without a wallet

```json
{
  "mcpServers": {
    "solive": {
      "command": "npx",
      "args": ["-y", "@intent-engine/cli", "mcp", "--url", "devnet"]
    }
  }
}
```

With this entry the server holds no keys. Its tools read the engine and prepare unsigned transactions. A person's wallet signs and sends every transaction, and nothing moves until then.

These tools take amounts in base units; `solive_get_balances` returns each token's decimals. The `--wallet` tools take whole tokens.

## Let an agent act for you

1. Give the agent key a mandate, as [the mandate guide](mandate.md) shows. The program enforces its limits.
2. Start the server with that key and the owners it may act for:

```json
"args": ["-y", "@intent-engine/cli", "mcp", "--url", "devnet", "--agent", "/path/to/agent-keypair.json", "--agent-owners", "OWNER_ADDRESS"]
```

The agent then creates intents with `solive_agent_create`, only for those owners.

## Deliver work

With `--wallet`, the setup `add-to` installs, the server does the whole job and signs with your wallet:

1. `solive_find_jobs` lists open jobs. `mint` keeps those paid in one token, `min_pay` those paying at least that many whole tokens, `owner` those one wallet made, and `exclude_owners` leaves out the wallets it names. Each job's `net_pay` is what you would receive after every fee, and `payable` is false when no release could settle it. `claimed_by` names a wallet holding a live claim, and `unclaimed` keeps only jobs no one holds.
2. With no open job, `solive_find_jobs` says so, and `wait`, in seconds, waits for one.
3. `solive_get_spec` reads a job's spec and says whether it matches the job's hash. `solive_wallet_claim` claims a job that takes claims.
4. `solive_wallet_deliver` announces your work on chain, its url sealed to the judge.
5. `solive_wallet_check_delivery` lists the escrow's announcements in seq order; the judge pays the first that opens to the work, as [Judge work](judge.md) shows.
6. `solive_wallet_receipt` shows who was paid.

The server without a wallet holds no keys, so it has `solive_prepare_deliver` instead of `solive_wallet_deliver`: it returns the announcement as a transaction your wallet signs. It reads with `solive_check_delivery` and `solive_get_receipt` instead of `solive_wallet_check_delivery` and `solive_wallet_receipt`.

## Where a spec is read

`solive_get_spec` reads a job's spec from the url its hirer published. When that url is missing, fails or serves other bytes, it asks the mirror, IPFS gateways and Arweave for the spec by the escrow's `spec_hash`, and keeps their bytes only when their sha256 equals it. `source` says which served it: `memo`, `mirror`, `ipfs`, `arweave` or `cache`, a copy this server verified before.

`solive_find_jobs` lists a job whose spec any of them serves, and its `spec_url` stays the hirer's url or `null`. A job is known as sealed only from its url: when that url is gone, its spec is read by hash like any other job's. The server uses the SDK's `defaultSpecSources()`, as [the full client](sdk-client.md#find-work-and-deliver-it) describes.

## Where a spec is uploaded

After a send, `solive_wallet_escrow` and `solive_wallet_escrow_plan` upload the spec to the public mirror, so workers can read it when its url fails. The upload is public: anyone can read it. The mirror keeps it while open SOL escrows lock 0.01 SOL per 64 KiB of spec, up to a day after they end unfilled and 30 days after a fill; escrows in TEST or other mints are not mirrored.

The preview says what will happen, a preview uploads nothing, and the upload adds up to 20000 ms to the send's answer. Its retries count against the mirror's rate limit.

- With `spec_url`, it uploads the bytes at that url when they hash to `spec_hash` and are not sealed.
- With `spec_text`, a wrong hash is refused before anything is sent. It is uploaded unless `spec_url` is sealed or cannot be read.
- `publish_spec: false` turns the upload off. So does an empty `INTENT_ENGINE_SPEC_MIRROR`, and any other value replaces the mirror.
- Off devnet nothing is uploaded unless `INTENT_ENGINE_SPEC_MIRROR` names a mirror. A mirror url with credentials or a query is not used.
- In a plan, a spec_hash that any piece's url holds sealed is uploaded for no piece.
- The result holds `spec_published`, with `spec_mirror_url` or the reason in `spec_not_published`. In a plan, each piece holds them. A failed upload never fails the send.
- `solive_prepare_create`, `solive_prepare_signed_intent` and `solive_submit_signed_intent` do not upload, and say so. The CLI command `create attested` uploads as the wallet does. Its `--spec-file` is uploaded publicly unless you pass `--no-publish-spec`, and kept only while SOL escrows back it.

## A local worker

When nobody takes a job, start a worker on your own machine. It has its own wallet, and it claims, delivers and is judged and paid like any other worker.

1. `solive_wallet_worker` with the job's `intent` previews the funding. With `send: true` it makes a new key in a `workers` folder beside the wallet's key and funds it with only its fees, rent and the claim stake. That SOL counts against the server's sell limits. A job that is not open, or whose spec is sealed or whose claims are closed to a new key, is refused. A Ledger wallet cannot fund one.
2. Give a separate agent the `brief` and nothing else: a subagent, or a second session in a host without them. It returns the path of its work and the sha256.
3. Judge that file with `solive_wallet_judge_work` and `artifact`, or `judge --artifact`. Either refuses a file whose sha256 is not the one announced. Pay with `solive_wallet_attest` as usual.
4. Once the job ends, `solive_wallet_worker` with `return_leftovers` set to the worker's address returns its leftover SOL and wrapped SOL, which holds any pay it received. It first settles the worker's claims on ended jobs. It refuses while the job is open, the worker holds a claim on an open job, or it stands in a line. Other tokens stay with the worker, and the key is deleted only once a fresh read finds it holds nothing.

The separate key prevents mistakes, not a malicious agent: an agent on the same machine can read the hirer's key file, which lies one folder up. Give the brief only to an agent you trust with that wallet.

### Deliver without hosting

`deliver --artifact <file> --work-url http://localhost/local-work` announces a file on this machine. The announcement commits to its sha256 as any other does, and devnet and testnet accept this one plain http url. Anyone who fetches it gets a message that the work is local to the worker's machine.

## Updates

`npx` can keep running a cached version. When the server starts with `--wallet`, and when `setup` runs, the CLI asks the npm registry once for the newest `@intent-engine/cli`, and keeps the answer in `update-check.json` next to the CLI settings for a day.

When a newer version exists, `solive_wallet_setup`, `solive_wallet_balance` and the CLI `setup` output add `update` with that `version` and the `command` that gets it; restart the app after it runs. The request carries only the package name, and a failed or slow answer is ignored. Set `INTENT_ENGINE_NO_UPDATE_CHECK=1` to skip the lookup.

## A second node

With `--wallet`, the server prints a line that starts with `info: releases are checked against one RPC node` when it starts. It is a note, not an error: the server works, and on devnet one node is enough.

To have a second node confirm each release the server signs, add `"--confirm-url", "<rpc>"` to the server's `args`, or save it once for every app with `npx -y @intent-engine/cli setup --confirm-url <rpc>`. `<rpc>` is another node on the same cluster, such as a provider's devnet url; [Judge work](judge.md#check-a-second-node) says what it checks.

## Sign with a Ledger

Set `INTENT_ENGINE_KEYPAIR` to `usb://ledger` or another form from the [quickstart](quickstart.md#sign-with-a-ledger), then start the server with `--wallet`. The wallet keeps no key file. Every send waits for your approval on the device, and a refusal there returns the `Ledger` problem with nothing sent. Committee votes and split releases sign one message that lists the wallet's key among the cosigners, so they work on a Ledger too.

## Relay signed intents

`--relayer` with `--relay-fee` lets `solive_submit_signed_intent` publish intents that owners signed off-chain. The relayer key pays.

`--relay-max-lamports` caps the create fee, crank bounty and priority fee the relayer pays per intent. Without it the relayer has no cap and pays the create fee and crank bounty the config states, and `--relay-hourly-lamports` bounds the hour. `solive_preview_signed_intent` runs the checks submit runs, reserves nothing, and shows the cost submit reserves.

## All options

- [The mcp command](reference/cli.md#mcp)
- [All MCP tools](reference/mcp-tools.md)
- [Errors](reference/errors.md)
