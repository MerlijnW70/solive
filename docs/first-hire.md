# Your first hired agent

Hire an agent from your AI on Solana devnet, watch it deliver, check the work without Docker, and pay. You need no spec of your own and no url: the AI offers a demo job, and a demo worker that this project runs does it. Devnet tokens have no value.

Do [Use it from your AI](ai.md) steps 1 and 2 first, so your wallet holds devnet SOL.

## 1. Ask to hire

In Claude Code type `/solive:hire`; in Codex, or any other app, ask:

> Hire an agent for a demo job.

The AI offers the demo jobs and tells you the task of the one you pick in plain words:

| Demo | Task | Spec |
|---|---|---|
| `fizzbuzz` | FizzBuzz for a number | [`examples/demo/fizzbuzz`](../examples/demo/fizzbuzz) |
| `palindrome` | tell whether a text is a palindrome | [`examples/demo/palindrome`](../examples/demo/palindrome) |
| `reverse-words` | reverse the words of a text | [`examples/demo/reverse-words`](../examples/demo/reverse-words) |

Each spec is served from this repository, so its url and its sha256 are fixed, and each lists the cases the judge runs.

## 2. Escrow the pay

The AI previews the escrow: your pay, such as 0.01 SOL, the demo's spec url and sha256, and your own wallet as the judge. Say yes and it sends. The pay waits in the escrow until you release it.

## 3. Wait for the delivery

The demo worker watches for escrows of a demo spec. Within minutes it claims yours when it takes claims, and announces its solution to you, the judge. Ask the AI to check the delivery; it lists the announcement and fetches the work.

## 4. Check the work

The AI judges the work with `solive_wallet_judge_work`. It fetches the spec and the work, runs the spec's cases in the ViperJS sandbox and in a second engine, and returns `"verdict": "pass"` only when every case passes, with the work's sha256. It sends nothing. It needs neither WSL nor Docker, so on Windows a demo job is judged as is. Docker, through `--sandbox docker`, is needed only for a spec that needs a container.

To judge from a terminal instead, download the spec and the work byte for byte and run:

```sh
npx -y @intent-engine/cli judge --owner <your address> --nonce <nonce> --spec SPEC.md --artifact work.mjs --sandbox viper
```

In Windows PowerShell, which refuses `npx` on a fresh PC, use `npx.cmd`, and download with `curl.exe -o`, since `Set-Content` adds bytes that change the sha256:

```powershell
npx.cmd -y @intent-engine/cli judge --owner <your address> --nonce <nonce> --spec SPEC.md --artifact work.mjs --sandbox viper
```

It sends nothing without `--yes`.

## 5. Pay

On a pass the AI previews the release to the worker. Say yes and it sends, then shows the receipt: who was paid, how much, and for which work. That is your first hired job.

To do the same from the command line, with your own spec, follow [Your first paid job](first-job.md).
