#!/usr/bin/env bash
#
# Provision a fresh Ubuntu box as the fez router — an OpenAI-compatible
# endpoint serving one small tool-calling model, so `@fez` routes with
# nothing installed on the user's machine. Idempotent; re-run freely.
#
#   ssh root@<ip> 'HOSTNAME_FOR_TLS=<host> bash -s' < deploy/router/provision-router.sh
#
# Deliberately a SEPARATE box from the relay. The relay holds the only
# copy of a community's history and its own README says memory is the
# constraint; putting a 400 MB model next to it trades "routing is a bit
# slow" for "the community is gone".
#
# What this does NOT do: install the gateway. That's deploy-router.sh,
# so shipping a policy change never re-runs system setup.
set -euo pipefail

HOSTNAME_FOR_TLS="${HOSTNAME_FOR_TLS:?set HOSTNAME_FOR_TLS, e.g. 165-227-0-1.sslip.io}"
# Q4_K_M, not Q8: measured on the 97-case battery it scores the same or
# better (90.7% vs 88.7%), at 397 MB instead of 639 MB. On a box this
# size the smaller file is the whole difference between comfortable and
# tight.
MODEL_URL="${MODEL_URL:-https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf}"
LLAMA_BUILD="${LLAMA_BUILD:-b10520}"
ROUTER_USER=fezrouter
ROUTER_HOME=/opt/fez-router
DATA_DIR=/var/lib/fez-router

say() { echo -e "\n\033[1m── $*\033[0m"; }

say "swap"
# Same reasoning as the relay box: an OOM kill is a router that has
# vanished. Swap turns a kill into a slowdown you can see coming.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
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
apt-get install -y -qq ca-certificates curl gnupg ufw unattended-upgrades unzip libgomp1 >/dev/null

say "node 22 (the gateway is one file, but it needs a runtime)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "router user + directories"
id -u "$ROUTER_USER" >/dev/null 2>&1 || useradd --system --home "$ROUTER_HOME" --shell /usr/sbin/nologin "$ROUTER_USER"
install -d -o "$ROUTER_USER" -g "$ROUTER_USER" "$ROUTER_HOME" "$ROUTER_HOME/bin" "$DATA_DIR"

say "llama.cpp ${LLAMA_BUILD} (prebuilt x64 — nothing is compiled on this box)"
if [ ! -x "$ROUTER_HOME/bin/llama-server" ] || [ "$(cat "$ROUTER_HOME/bin/.build" 2>/dev/null)" != "$LLAMA_BUILD" ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/llama.tar.gz" \
    "https://github.com/ggml-org/llama.cpp/releases/download/${LLAMA_BUILD}/llama-${LLAMA_BUILD}-bin-ubuntu-x64.tar.gz"
  tar xzf "$tmp/llama.tar.gz" -C "$tmp"
  # The tarball carries llama-server plus the shared libs it links.
  find "$tmp" -type f \( -name 'llama-server' -o -name '*.so*' \) -exec install -m 0755 {} "$ROUTER_HOME/bin/" \;
  echo "$LLAMA_BUILD" > "$ROUTER_HOME/bin/.build"
  chown -R "$ROUTER_USER:$ROUTER_USER" "$ROUTER_HOME/bin"
  rm -rf "$tmp"
fi
# The binary finds its siblings without a system-wide ldconfig entry.
grep -q "$ROUTER_HOME/bin" /etc/ld.so.conf.d/fez-router.conf 2>/dev/null || {
  echo "$ROUTER_HOME/bin" > /etc/ld.so.conf.d/fez-router.conf
  ldconfig
}
"$ROUTER_HOME/bin/llama-server" --version 2>&1 | head -2 || true

say "model"
if [ ! -s "$DATA_DIR/model.gguf" ]; then
  curl -fsSL -o "$DATA_DIR/model.gguf.part" "$MODEL_URL"
  mv "$DATA_DIR/model.gguf.part" "$DATA_DIR/model.gguf"
fi
chown "$ROUTER_USER:$ROUTER_USER" "$DATA_DIR/model.gguf"
ls -lh "$DATA_DIR/model.gguf"

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

say "firewall"
# 8080 and 8081 are deliberately absent: Caddy reaches the gateway over
# loopback, and the model server is only ever reachable from the gateway.
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
# fez router — TLS terminated here, plain HTTP to the gateway behind it.
# The gateway (not llama-server) is the proxy target: it holds the rate
# limit, the token clamp and the auth check.
${HOSTNAME_FOR_TLS} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8081
}
CADDY
caddy validate --config /etc/caddy/Caddyfile >/dev/null && echo "Caddyfile valid"
systemctl reload caddy 2>/dev/null || systemctl restart caddy

say "done"
echo "provisioned for ${HOSTNAME_FOR_TLS}"
echo "next: deploy/router/deploy-router.sh root@<ip>  (ships the gateway + units)"
