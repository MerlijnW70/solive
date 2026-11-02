# Spec mirror

Serves job specs by their sha256 from public Vercel Blob, under `sha256/<hex>`. It stores a spec only while the program holds an open proof escrow with that `spec_hash`. Stored bytes stay after the escrow closes; the service has no way to overwrite or delete them.

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
| `PUT` | 429 | caller over 20 uploads an hour, with `retry-after`; each function instance counts its own |
| `PUT` | 503 | the node is not on devnet, or the node or the store failed |

## Before wide public use

Nothing caps total storage yet. The rate limit is per function instance, so it does not bound a caller across instances, and an open escrow is the only other gate. Add a global quota or a firewall rule before wide public use.

## Sealed specs

`spec_hash` is the hash of the plaintext, so the escrow account does not show whether a job is sealed and this service does not check. Anyone holding the plaintext of a sealed spec could publish it here, for good. Do not reuse a spec that must stay private.

## Deploy

1. Create a Vercel project with `services/specs` as its root directory and files outside the root included, so `vercel.json` can build the workspace packages. Connect a public Blob store, which sets `BLOB_STORE_ID` and uses OIDC.
2. Set `SPECS_RPC_URL` when not using the default `https://api.devnet.solana.com`. A node on another cluster is refused by genesis hash.
3. Deploy.

## Read through it

```ts
const client = createClient({
  url: "https://api.devnet.solana.com",
  specSources: [{ kind: "memo" }, { kind: "mirror", base: "https://<your-deployment>" }],
});
```

`memo` stays first: a spec is read from its own url, and seen sealed, before any copy. `DEFAULT_SPEC_SOURCES` lists this service.
