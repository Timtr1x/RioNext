#!/bin/sh
set -eu

if [ -n "${RIONEXT_ALLOW_IPS:-}" ] && command -v iptables >/dev/null 2>&1; then
  iptables -F OUTPUT 2>/dev/null || true
  iptables -P OUTPUT DROP 2>/dev/null || true
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
  old_ifs=$IFS
  IFS=,
  for ip in $RIONEXT_ALLOW_IPS; do
    [ -n "$ip" ] && iptables -A OUTPUT -d "$ip" -j ACCEPT
  done
  IFS=$old_ifs
fi

# Persistent Playwright for the agent. Campaign kill removes this process tree with the container.
if [ -x /opt/rionext/pw-daemon.mjs ] || [ -f /opt/rionext/pw-daemon.mjs ]; then
  node /opt/rionext/pw-daemon.mjs >> /var/log/rionext-pw.log 2>&1 &
  i=0
  while [ "$i" -lt 20 ]; do
    if node -e "fetch('http://127.0.0.1:18765/').then(()=>process.exit(0)).catch(()=>process.exit(1))" 2>/dev/null; then
      break
    fi
    i=$((i + 1))
    sleep 0.3
  done
fi

exec "$@"
