# Spec mirror

Serves job specs by their sha256 from public Vercel Blob, under `sha256/<hex>`. It stores a spec only when the open proof escrows with that `spec_hash` lock enough SOL, and charges it to one owner's quota. The service never overwrites a blob, and every read re-hashes the bytes, so the bytes at an address never change. A daily sweep removes a spec once the SOL behind it is gone: within a day when its escrows were cancelled or expired, 30 days later when filled SOL escrows paid its cost. An upload that needs room removes unbacked specs at once.

| Request | Status | When |
|---|---|---|
| `GET` or `HEAD /sha256/{hex}` | 200 | the exact bytes (`HEAD`: the headers only), immutable cache, `access-control-allow-origin: *` |
| `GET` or `HEAD /ipfs/{cid}?format=raw` | 200 | the same bytes, for the CIDv1 raw sha256 of the hash |
| either | 400 | not 64 lowercase hex characters, not such a CID, or no `format=raw` |
| either | 404 | unknown hash |
| either | 503 | the store failed, or its bytes do not hash to the address |
| `PUT /sha256/{hex}` | 201, 200 | stored; already stored, nothing written |
| `PUT` | 413 | body over the 1048576 byte cap readers use (`MAX_SPEC_BYTES`) |
| `PUT` | 400 | bad hex, or the body's sha256 is not `{hex}` |
| `PUT` | 403 | no open AttestedResult escrow holds this hash, also when the bytes are already stored |
| `PUT` | 402 | those escrows lock less SOL together than the cost; `min_escrowed` in the body and `x-min-escrowed` give it in lamports |
| `PUT` | 429 | caller over 20 uploads an hour, with `retry-after`; each function instance counts its own |
| `PUT` | 507 | `x-spec-limit: total`: the store would hold more than 536870912 bytes (512 MiB) even after removing specs without SOL behind them; `x-spec-limit: owner`: every owner of those escrows holds 16777216 bytes (16 MiB) or would pass that. A spec already stored still answers 200 |
| `PUT` | 503 | the node is not on devnet, or the node or the store failed, also when the stored total cannot be counted |

## Before wide public use

Total storage is capped at 536870912 bytes (`MAX_STORED_BYTES`). Before a new write the service sums the sizes of the blobs under `sha256/`. At or over the cap, or when the write would pass it, it first removes specs without SOL behind them, as below, and answers 507 when that frees too little. The cap is soft: instances count at the same time, so together they can pass it by a few writes of at most 1048576 bytes each. A count that cannot finish answers 503 and stores nothing. Reads have no limit, and the rate limit is per function instance, so it does not bound a caller across instances. Add a firewall rule before wide public use.

## Cost, quota and expiry

| Rule | Value | Constant |
|---|---|---|
| Backing | open escrows with the hash lock 10000000 lamports (0.01 SOL) together per 65536 bytes begun, while the spec is kept | `MIN_ESCROW_UNITS`, `COST_STEP_BYTES` |
| Owner quota | 16777216 bytes of stored specs per escrow owner | `MAX_OWNER_BYTES` |
| Unpaid grace | 1 hour after the first sweep that finds the spec without backing; the daily sweep makes it up to a day | `UNPAID_GRACE_SECS` |
| Paid grace | 30 days, when filled or filling SOL escrows with the hash lock the backing together | `PAID_GRACE_SECS` |
| Sweep | daily cron at `/api/sweep`, at most 100 node checks and 40 seconds a run | `MAX_CHECKS_PER_SWEEP`, `SWEEP_BUDGET_MS` |

Backing counts the lamports of open SOL escrows only, so an upload right after the escrow is created works, and the docs' 0.01 SOL job backs a spec of up to 64 KiB. TEST does not count: the devnet filler sells 200 TEST for 1 SOL, so 0.01 TEST costs 0.00005 SOL, and other mints cost nothing to make. A TEST job's spec is still read from its own url.

Before writing, the service charges the spec to the first owner, by address, of an open SOL escrow with room: it writes the one-byte mark `owners/<owner>/<hex>.<size>`, then the spec. An owner's use is the sum over its marks, and a mark whose spec never landed is removed after a day. The quota is soft: uploads running at the same time each see the owner's use before the others, so it can pass the quota by at most one spec per concurrent `PUT`.

A sweep asks the node once for the hash, mint and amount of every open proof escrow, and lists `sha256/`, `idle/` and `owners/` once. A backed spec loses its `idle/<hex>.<grace>` mark. An unbacked one without a mark gets one: `paid` when filled or filling SOL escrows with the hash lock the backing together, else `unpaid`. The mark's upload time starts the grace. A new `PUT` of a stored spec whose escrows back it also clears the mark.

When a grace ends the sweep asks the node again whether filled SOL escrows pay for the spec, then whether open ones back it, and deletes the spec and its marks only when neither holds within its grace. An escrow opened between the last look and the delete loses the copy; its next `PUT` stores it again.

An upload at the cap frees room at once, without waiting for any grace, oldest unbacked spec first. It skips specs marked `paid` within their 30 days without asking the node. For each other spec it asks the node whether filled SOL escrows pay for it; a paid one gets the `paid` mark and is skipped, the rest are deleted as above. One upload deletes at most 20 specs (`MAX_EVICTIONS_PER_PUT`) and makes at most 60 such node calls (`MAX_ROOM_LOOKUPS_PER_PUT`), so paid specs neither stop it from reaching cancelled ones behind them nor make it read without bound.

Each listing, write and mark is a Blob advanced operation, and removals are batched by 100. A new spec costs one more list and one more write than before. A sweep costs three listings and one node call, plus up to two node calls and one store call per checked spec. Set `CRON_SECRET` in the project: the sweep answers 401 without it. The cron runs daily because Vercel Hobby allows no more, so an unpaid spec lasts up to a day; an upload at the cap frees unbacked space at once.

### The cheapest way to fill the store

Fresh keypairs cost nothing, so the owner quota only stops a careless single key. The limits that hold are SOL:

- Keep 536870912 bytes backed: 81.92 SOL locked in open escrows for as long as the store stays full, since a cancelled escrow's spec gives way to the next upload at the cap.
- Fill with self-paid jobs: escrow 0.16 SOL per MiB in one SOL escrow, or several that add up, upload, judge the own work and pay the own worker, so the spec keeps the 30-day paid grace. Filled escrows below the cost, or in TEST or another mint, earn only the short grace. The SOL comes back at the fill and can pay the next job, so 512 MiB for 30 days costs 512 jobs: the AttestedResult protocol fee (`feeBps` in the config) on 81.92 SOL plus about three transaction fees per job. With a zero fee that is only the transaction fees; a fee, or a shorter `PAID_GRACE_SECS`, is the lever.

## Sealed specs

`spec_hash` is the hash of the plaintext, so the escrow account does not show whether a job is sealed and this service does not check. Anyone holding the plaintext of a sealed spec could publish it here, for as long as its escrows back it and up to 30 days after a fill that paid its cost. Do not reuse a spec that must stay private.

## Deploy

1. Create a Vercel project with `services/specs` as its root directory and files outside the root included, so `vercel.json` can build the workspace packages. Connect a public Blob store, which sets `BLOB_STORE_ID` and uses OIDC.
2. Set `SPECS_RPC_URL` when not using the default `https://api.devnet.solana.com`. A node on another cluster is refused by genesis hash.
3. Set `CRON_SECRET` to a long random value, so the daily sweep runs.
4. Deploy.

## Read through it

```ts
const client = createClient({
  url: "https://api.devnet.solana.com",
  specSources: [{ kind: "memo" }, { kind: "mirror", base: "https://<your-deployment>" }],
});
```

`memo` stays first: a spec is read from its own url, and seen sealed, before any copy. `DEFAULT_SPEC_SOURCES` lists this service.
