# Company-only jobs

Post a job whose spec only the workers you choose can read. Do steps 1 and 2 of the [quickstart](quickstart.md) first.

## What stays private

| Private | Public |
|---|---|
| The spec | That the job exists, its amount, payer and judge |
| The work, behind a link only the judge can open | The work's hash, its link and the worker |

The program still binds the spec by its hash, so the judge can only pay for work against that exact spec.

## 1. Post the job without a spec link

Write the spec to `spec.md`, keep it to yourself, and post the job with only its hash:

```sh
export JUDGE=$(intent-engine balance | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).address')
export SPEC_HASH=$(intent-engine hash --artifact spec.md | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).sha256')
intent-engine create attested --input-mint SOL --output-mint TEST --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor $JUDGE --spec-hash $SPEC_HASH --expires-in 86400 --yes
```

In PowerShell:

```powershell
$env:JUDGE = (intent-engine balance | Out-String | ConvertFrom-Json).address
$env:SPEC_HASH = (intent-engine hash --artifact spec.md | Out-String | ConvertFrom-Json).sha256
intent-engine create attested --input-mint SOL --output-mint TEST --units tokens --amount-in 0.01 --min-result 1 --max-result 1 --attestor $env:JUDGE --spec-hash $env:SPEC_HASH --expires-in 86400 --yes
```

## 2. Send the spec to the workers you choose

Send `spec.md` the way you share any company file. `jobs` lists the job with `specUrl` set to `null`.

## 3. The worker checks the spec

```sh
intent-engine jobs --attestor $JUDGE
intent-engine hash --artifact spec.md
```

In PowerShell:

```powershell
intent-engine jobs --attestor $env:JUDGE
intent-engine hash --artifact spec.md
```

The worker takes the job only when the `sha256` it prints equals the job's `specHash`.

## 4. The worker delivers behind a private link

```sh
intent-engine deliver --intent $INTENT --artifact work --work-url $WORK_URL --yes
```

In PowerShell:

```powershell
intent-engine deliver --intent $env:INTENT --artifact work --work-url $env:WORK_URL --yes
```

`$WORK_URL` points to a place only the judge can open, such as a private repository. The link and the work's hash are public; the work is not.

## 5. Judge and pay

Judge as in [Judge work](judge.md). Pay only the workers you sent the spec to.

## Next

- [Judge work](judge.md)
- [All commands](reference/cli.md)
