import { ACCEPTS, GLOBAL_OPTIONS } from "./arg-options.js";
import { EXIT_ALERTED } from "./monitor-args.js";

export const COMMANDS = "setup | add-to claude|codex | balance | pda | domain | mcp | show config | show intent | show mint-cap | quote | cancel | expire | close | advance-nonce | advance-epoch | create swap|limit|dutch|attested | list | mandate grant|show|revoke|use <kind> | approve | revoke-approval | signed prepare <kind>|submit | init-config | update-config | set-economics | propose-admin | accept-admin | set-mint-cap | set-caps-required on|off | solve | raise-pause | lower-pause | crank | treasury | solver-table | events | jobs | deliver | deliveries | receipt | record-delivery | judge | committee create|show|vote|release | claims show | claims open | claims take | claims drop | claims settle | profile show | profile set | profile close | reputation | feedback | monitor | hash | seal | unseal | spec | version | help [command]";

export const USAGE = `usage: ${COMMANDS}`;

const MANDATE_ORDER_SHAPE = "(--amount-in --min-out | --make --take | --amount-in --start-out --end-out --start-at --end-at)";

const ORDER_SHAPE = "(--amount-in --min-out | --make --take | --amount-in --start-out --end-out --start-at --end-at | --amount-in --min-result --max-result --attestor)";

const PARTNER_SHAPE = "[--partner <address> --partner-bps <n>]";

export const SHAPES: Readonly<Record<string, string>> = {
  setup: "[--url <cluster>] [--keypair <file>]",
  "add-to": "claude|codex [--wallet-per-trade <token=amount,...>] [--wallet-per-hour <token=amount,...>]",
  balance: "[--keypair <file> | --owner <address>] [--mints <mint,...>]",
  pda: "--owner <address> --nonce <n>",
  hash: "--artifact <file or directory>",
  seal: "--file <file> --to <wallet,...> --out <file>",
  unseal: "--file <sealed file> --keypair <file> --out <file>",
  spec: "--intent <escrow address> [--keypair <file>] [--out <file>]",
  show: "config | intent --owner <address> --nonce <n> | mint-cap --mint <mint>",
  domain: "",
  mcp: "[--wallet [--wallet-per-trade <token=amount,...>] [--wallet-per-hour <token=amount,...>] [--all-tools]] [--relayer <keypair> --relay-fee <mint=amount,...> [--relay-max-lamports] [--relay-max-ttl] [--relay-per-hour] [--relay-hourly-lamports]] [--agent <keypair> --agent-owners <address,...> [--agent-hourly-lamports]] [--confirm-url <cluster>]",
  quote: "--owner <address> --nonce <n> [--at <unix>]",
  cancel: "--keypair <file> --nonce <n> [--close] [--yes]",
  expire: "--keypair <file> --owner <address> --nonce <n> [--yes]",
  close: "--keypair <file> --owner <address> --nonce <n> [--yes]",
  "advance-nonce": "--keypair <file> --base <n>",
  "advance-epoch": "--keypair <file>",
  "init-config": "(--keypair <file> [--yes] | --authority <address>) --guardian --fee-recipient --fee-bps --kinds [--flags create|fill|all]",
  "update-config": "(--keypair <file> [--yes] | --authority <address>) and any of --guardian --fee-recipient --fee-bps --kinds --fill-disabled",
  "propose-admin": "(--keypair <file> [--yes] | --authority <address>) --new-admin <address>",
  "accept-admin": "(--keypair <file> [--yes] | --authority <address>)",
  "set-mint-cap": "(--keypair <file> [--yes] | --authority <address>) --mint <mint> --max-per-order <raw> --window-cap <raw> --window-secs <n>",
  "set-caps-required": "on|off (--keypair <file> [--yes] | --authority <address>)",
  "raise-pause": "(--keypair <file> [--yes] | --authority <address>) --flags create|fill|all",
  "lower-pause": "(--keypair <file> [--yes] | --authority <address>) --flags create|fill|all",
  "set-economics": "(--keypair <file> [--yes] | --authority <address>) --bounty --create-fee [--kind-fees] [--partner-cut]",
  solve: "--keypair <file> [--inventory <input mint>:<output mint>=<out>/<in>,...] [--jupiter <url> | --issue <input mint>:<output mint>=<out>/<in>,...] --min-profit <output mint=raw,...> [--sol-value <mint>=<raw>/<lamports>,...] [--target-profit <output mint=raw,...> [--patience <seconds>]] [--priority-fee <micro-lamports|auto>] [--max-fee-bps <n>] [--max-sol-cost <SOL>] [--max-rent <SOL>] [--slippage-bps <n>] [--jito <url> [--tip <lamports>] [--bundle-size <n>]] [--route-program <program the aggregator swaps through>] [--lookup-table <address,...>] [--concurrency <n>] [--watch [--interval <seconds>] [--quote-ttl <seconds>] [--stats]]",
  "solver-table": "--solver <address> --mints <mint,...>",
  crank: "--keypair <file> [--dry-run] [--fund-accounts]",
  treasury: "[--mints <mint,...>] [--create --mints <mint,...> --keypair <payer file> [--yes]]",
  events: "[--limit <n>] [--follow [--interval <seconds>]]",
  jobs: "[--attestor <address>] [--mint <SOL, TEST or mint>] [--min-pay <tokens>] [--unclaimed]",
  deliver: "--keypair <worker file> --intent <address> (--artifact <file or directory> | --sha256 <64 hex>) --work-url <https url> [--yes]",
  deliveries: "--attestor <address> --intent <address> [--max-pages <n>]",
  receipt: "--owner <address> --nonce <n> [--sha256 <64 hex>] [--release <signature>]",
  "record-delivery": "--keypair <judge file> --owner <address> --nonce <n> --sha256 <64 hex> [--release <signature>] [--yes]",
  reputation: "--worker <address> [--max-pages <n>]",
  feedback: "--keypair <owner file> --intent <address> --score <0 to 100> [--note <sha256 of a note>] [--yes]",
  committee:
    "create --keypair <payer file> --members <address,...> --threshold <n> --fee-wallet <address> [--yes] | show --committee <address> | vote --keypair <member file> --owner <address> --nonce <n> --pay-to <wallet> --result <n> [--out <file>] [--yes] | release --keypair <solver file> --vote <file> [--vote <file> ...] [--sha256 <64 hex>] [--confirm-url <cluster>] [--yes]",
  claims:
    "show --owner <address> --nonce <n> | open --keypair <owner file> --nonce <n> --max-secs <seconds> --stake <SOL> [--yes] | take --keypair <worker file> --owner <address> --nonce <n> --secs <seconds> [--yes] | drop --keypair <worker file> --owner <address> --nonce <n> [--yes] | settle --keypair <payer file> --owner <address> --nonce <n> [--yes]",
  profile:
    "show --wallet <address> | set --keypair <file> --skills <tag,...> --endpoint <https url> [--doc-url <https url> --doc-sha256 <64 hex>] [--yes] | close --keypair <file> [--yes]",
  judge: "--keypair <judge file> --owner <address> --nonce <n> --spec <file> (--artifact <file or directory> | --watch [--interval <seconds>]) (--run <command> | --sandbox viper) [--pay-to <wallet>] [--result <n>] [--timeout <seconds>] [--verdict <file>] [--max-pages <n>] [--check <file or directory>] [--sandbox docker|viper|none] [--sandbox-image <name>@sha256:<64 hex>] [--sandbox-memory <n>m|<n>g] [--sandbox-cpus <n>] [--plain-node] [--confirm-url <cluster>] [--yes]",
  create: `swap|limit|dutch|attested --keypair <file> --input-mint --output-mint (--expires-at | --expires-in) ${ORDER_SHAPE} [--nonce <n>] [--pay-to <wallet>] ${PARTNER_SHAPE} [--units tokens|raw] [--yes]; attested takes [--spec-hash <64 hex> [--judge-fee <amount>] [--spec-url <https url>]] to make a proof escrow`,
  list: "--owner <address> or --keypair <file>; --owner wins when both are given",
  mandate: `grant --keypair <file> --agent --input-mint --output-mint --kinds --per-intent --total --max-intents --max-ttl --valid-for --floor-out --floor-in [--agent-fee] ${PARTNER_SHAPE} [--id] [--units tokens|raw] [--yes] | show --agent (--owner <address> | --keypair <file>) [--id] | revoke --keypair <file> --agent [--id] [--yes] | use swap|limit|dutch --keypair <file> --owner (--expires-at | --expires-in) ${MANDATE_ORDER_SHAPE} [--id] [--nonce <n>] [--units tokens|raw] [--yes]`,
  approve: "--keypair <file> --mint <mint> --amount <amount> [--units tokens|raw] [--yes]",
  "revoke-approval": "--keypair <file> --mint <mint> [--yes]",
  monitor: `--expect <baseline file> [--interval <seconds>] [--max-fill <mint>=<raw amount>]... [--max-fills <count>] [--webhook <https url>] [--once] | --write-baseline <file>; prints each alert as one JSON line; with --once it exits 0 when nothing alerted and ${EXIT_ALERTED} when anything did`,
  signed: `prepare swap|limit|dutch|attested --keypair <file> --out <file> --input-mint --output-mint (--expires-at | --expires-in) ${ORDER_SHAPE} [--nonce <n>] [--submit-within <seconds>] [--relayer-fee] ${PARTNER_SHAPE} [--units tokens|raw] [--yes] | submit --keypair <relayer file> --file <file> [--yes]`,
};

export function usageOf(verb: string | undefined): { usage: string; options: string[] } {
  const known = verb !== undefined && ACCEPTS[verb] !== undefined;
  return {
    usage: known ? `${verb} ${SHAPES[verb] ?? ""}`.trim() : COMMANDS,
    options: known ? [...(ACCEPTS[verb] ?? []), ...GLOBAL_OPTIONS].map((o) => `--${o}`) : [],
  };
}
