#!/usr/bin/env bash
#
# Provision a fresh Ubuntu box as a public fez relay. Idempotent — safe
# to re-run; it converges rather than assuming a clean machine.
#
#   ssh root@<ip> 'bash -s' < deploy/provision.sh
#
# What it does NOT do: put the relay binary in place. That's deploy.sh,
# so shipping a new build never re-runs system setup.
set -euo pipefail

HOSTNAME_FOR_TLS="${HOSTNAME_FOR_TLS:?set HOSTNAME_FOR_TLS, e.g. 67-205-188-204.sslip.io}"
RELAY_USER=fez
RELAY_HOME=/opt/fez
DATA_DIR=/var/lib/fez

say() { echo -e "\n\033[1m── $*\033[0m"; }

say "swap"
# Node on a 1 GB box gets OOM-killed under pressure, and an OOM-killed
# relay is a community that has vanished. Swap turns a kill into a
# slowdown you can see coming in the memory alert.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=10 >/dev/null
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi
free -m | head -3

say "packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades sqlite3 >/dev/null

say "node 22 (node:sqlite needs 22+; ubuntu ships 18)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node --version
node -e 'require("node:sqlite"); console.log("node:sqlite ok")'

say "caddy (automatic TLS)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
caddy version

say "relay user + directories"
id -u "$RELAY_USER" >/dev/null 2>&1 || useradd --system --home "$RELAY_HOME" --shell /usr/sbin/nologin "$RELAY_USER"
install -d -o "$RELAY_USER" -g "$RELAY_USER" "$RELAY_HOME" "$DATA_DIR" "$DATA_DIR/backups"

say "firewall"
# 7777 is deliberately absent: Caddy proxies to it over loopback, so the
# relay port is never reachable from outside even though the process
# binds all interfaces.
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status numbered | head -8

say "unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

say "caddy site"
cat > /etc/caddy/Caddyfile <<CADDY
# fez relay — TLS terminated here, plain ws over loopback behind it.
# Caddy upgrades WebSockets through reverse_proxy without extra config.
${HOSTNAME_FOR_TLS} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:7777
}
CADDY
# Logs go to journald (journalctl -u caddy). A file sink here needs a
# directory the hardened caddy unit can write to, and getting that wrong
# takes the whole listener down — which is how this box spent its first
# ten minutes with no TLS at all.
caddy validate --config /etc/caddy/Caddyfile >/dev/null && echo "Caddyfile valid"
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "nightly backup"
# A relay may hold the only copy of a community's history. `.backup` is
# used rather than cp because it is safe against a live writer.
cat > /usr/local/bin/fez-backup <<'BACKUP'
#!/usr/bin/env bash
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="/var/lib/fez/backups/relay-${STAMP}.sqlite"
sqlite3 /var/lib/fez/relay.sqlite ".backup '${OUT}'"
gzip -f "$OUT"
# keep 14 days
find /var/lib/fez/backups -name 'relay-*.sqlite.gz' -mtime +14 -delete
BACKUP
chmod +x /usr/local/bin/fez-backup
cat > /etc/systemd/system/fez-backup.service <<'UNIT'
[Unit]
Description=Back up the fez relay store
[Service]
Type=oneshot
User=fez
ExecStart=/usr/local/bin/fez-backup
UNIT
cat > /etc/systemd/system/fez-backup.timer <<'UNIT'
[Unit]
Description=Nightly fez relay backup
[Timer]
OnCalendar=daily
Persistent=true
RandomizedDelaySec=15m
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now fez-backup.timer >/dev/null

say "done"
echo "provisioned for ${HOSTNAME_FOR_TLS}"
echo "next: deploy/deploy.sh to ship the relay itself"
