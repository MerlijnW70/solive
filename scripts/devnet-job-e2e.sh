#!/usr/bin/env bash
set -euo pipefail
cli="${CLI:-intent-engine}"
url="${URL:-devnet}"
hirer="$(realpath "${HIRER:?set HIRER to the key file of the devnet wallet that hires and judges}")"
backup="$(realpath "${BACKUP_DIR:?set BACKUP_DIR to the folder that keeps worker key backups}")"
work="$(mktemp -d)"
export HOME="$work/home"
export INTENT_ENGINE_NO_UPDATE_CHECK=1
mkdir -p "$HOME"
job="e2e-$(date +%s)-$$"
spec="$work/$job.md"
artifact="$work/$job.txt"
printf '# %s\n\nDeliver one text file. The check is true.\n' "$job" > "$spec"
printf 'work of %s\n' "$job" > "$artifact"
field() { node -e 'const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]]; if (v === undefined) process.exit(1); console.log(v)' "$1" "$2"; }
now() { date +%s%3N; }
t0="$(now)"
$cli job create --url "$url" --keypair "$hirer" --name "$job" --spec "$spec" --worker-key "$job-w" --amount 0.001 --backup-dir "$backup" --jobs-dir "$work/jobs" --keys-dir "$work/keys" --no-publish-spec --yes > "$work/created.json"
intent="$(field "$work/jobs/$job.json" intent)"
nonce="$(field "$work/jobs/$job.json" nonce)"
owner="$(field "$work/jobs/$job.json" judge)"
$cli job create --url "$url" --keypair "$hirer" --name "$job" --spec "$spec" --worker-key "$job-w" --amount 0.001 --backup-dir "$backup" --jobs-dir "$work/jobs" --keys-dir "$work/keys" --no-publish-spec --yes > "$work/again.json"
[[ "$(field "$work/again.json" sent)" == false && "$(field "$work/again.json" intent)" == "$intent" ]]
t1="$(now)"
$cli deliver --url "$url" --keypair "$work/keys/$job-w.json" --intent "$intent" --artifact "$artifact" --work-url "https://example.org/e2e/$job" --yes > "$work/delivered.json"
delivered="$(field "$work/delivered.json" delivered)"
t2="$(now)"
$cli judge --url "$url" --keypair "$hirer" --owner "$owner" --nonce "$nonce" --spec "$spec" --artifact "$artifact" --run true --sandbox none --i-trust-this-work --yes > "$work/judged.json"
t3="$(now)"
[[ "$(field "$work/judged.json" verdict)" == pass ]]
paid="$(field "$work/judged.json" signature)"
$cli deliveries --url "$url" --intent "$intent" --judge-keypair "$hirer" --compare "$artifact" > "$work/deliveries.json"
node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); for (const a of d.announcements) console.log(`history seq=${a.seq} sha256=${a.sha256} from=${a.sha256_from} state=${a.state} announced_at=${a.announced_at}`)' "$work/deliveries.json"
echo "job=$job intent=$intent create_ms=$((t1 - t0)) deliver_ms=$((t2 - t1)) judge_ms=$((t3 - t2)) delivered=[$delivered] paid=$paid work=$work"
