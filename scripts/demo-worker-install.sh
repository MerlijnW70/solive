#!/usr/bin/env bash
set -euo pipefail
dest="${DEMO_WORKER_INSTALL_ROOT:-}"
user="${DEMO_WORKER_USER:-dev}"
home="/home/$user"
checkout="$home/solive"
log="$home/demo-worker.log"
if [[ -z "$dest" && "$(id -u)" != 0 ]]; then
  echo "run this as root, such as with sudo, or set DEMO_WORKER_INSTALL_ROOT to write the files under another root" >&2
  exit 1
fi
unit="$dest/etc/systemd/system/solive-demo-worker.service"
rotate="$dest/etc/logrotate.d/solive-demo-worker"
mkdir -p "$(dirname "$unit")" "$(dirname "$rotate")"
cat > "$unit" <<EOF
[Unit]
Description=solive devnet demo worker
After=network-online.target

[Service]
User=$user
WorkingDirectory=$checkout
Environment=DEMO_WORKER_KEYPAIR=$home/.config/intent-engine/demo-worker.json
Environment=DEMO_WORKER_CLI=$home/solive-filler/node_modules/.bin/intent-engine
ExecStartPre=/bin/bash $checkout/scripts/demo-worker-log.sh $log
ExecStart=/bin/bash $checkout/scripts/demo-worker.sh
Restart=always
RestartSec=15
StandardOutput=append:$log
StandardError=append:$log

[Install]
WantedBy=multi-user.target
EOF
cat > "$rotate" <<EOF
$log {
  size 10M
  rotate 5
  compress
  missingok
  notifempty
  copytruncate
}
EOF
chmod 0644 "$unit" "$rotate"
echo "unit: $unit"
echo "logrotate: $rotate"
if [[ -z "$dest" ]]; then
  touch "$log"
  chown "$user:$user" "$log"
  logrotate --debug "$rotate" >/dev/null 2>&1 || { echo "logrotate refused $rotate" >&2; exit 1; }
  systemctl daemon-reload
  echo "installed; start the new unit with: systemctl restart solive-demo-worker"
fi
