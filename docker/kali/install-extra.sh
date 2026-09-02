#!/bin/sh
# Extra pentest binaries and offline knowledge bases on top of kali-linux-headless.
# Pinned GitHub release URLs. Knowledge bases are depth-1 clones at image build time.
set -eu

rm -f /etc/apt/sources.list.d/kali.sources
printf '%s\n' 'deb http://kali.download/kali kali-rolling main contrib non-free non-free-firmware' > /etc/apt/sources.list

apt-get update
apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
  nuclei \
  chisel \
  httpx-toolkit \
  unzip \
  ripgrep \
  git \
  ca-certificates \
  curl

mkdir -p /usr/local/bin /opt/kb /opt/nuclei-templates \
  /home/rionext/.config/nuclei /root/.config/nuclei
ln -sf /usr/bin/httpx-toolkit /usr/local/bin/httpx-pd

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

# katana v1.7.0 (ProjectDiscovery crawler)
curl -fsSL -o katana.zip \
  "https://github.com/projectdiscovery/katana/releases/download/v1.7.0/katana_1.7.0_linux_amd64.zip"
unzip -qo katana.zip
install -m 0755 katana /usr/local/bin/katana

# dalfox v3.2.2 (XSS scanner)
curl -fsSL -o dalfox.tgz \
  "https://github.com/hahwul/dalfox/releases/download/v3.2.2/dalfox-v3.2.2-linux-x86_64.tar.gz"
tar -xzf dalfox.tgz
DALFOX_BIN=$(find . -maxdepth 2 -type f -name dalfox | head -n 1)
install -m 0755 "$DALFOX_BIN" /usr/local/bin/dalfox

# kerbrute v1.0.3
curl -fsSL -o /usr/local/bin/kerbrute \
  "https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64"
chmod 0755 /usr/local/bin/kerbrute

# cloudfox v2.0.5
curl -fsSL -o cloudfox.zip \
  "https://github.com/BishopFox/cloudfox/releases/download/v2.0.5/cloudfox-linux-amd64.zip"
unzip -qo cloudfox.zip
CLOUDFOX_BIN=$(find . -maxdepth 3 -type f -name cloudfox | head -n 1)
install -m 0755 "$CLOUDFOX_BIN" /usr/local/bin/cloudfox

# Nuclei YAML templates (the scanner is useless without these)
git clone --depth 1 https://github.com/projectdiscovery/nuclei-templates.git /opt/nuclei-templates
rm -rf /opt/nuclei-templates/.git
ln -sfn /opt/nuclei-templates /opt/kb/nuclei-templates

printf '%s\n' 'templates-directory: /opt/nuclei-templates' 'disable-update-check: true' \
  > /home/rionext/.config/nuclei/config.yaml
cp /home/rionext/.config/nuclei/config.yaml /root/.config/nuclei/config.yaml

# Knowledge bases
git clone --depth 1 https://github.com/swisskyrepo/PayloadsAllTheThings.git /opt/kb/PayloadsAllTheThings
rm -rf /opt/kb/PayloadsAllTheThings/.git
git clone --depth 1 https://github.com/HackTricks-wiki/hacktricks.git /opt/kb/HackTricks
rm -rf /opt/kb/HackTricks/.git
git clone --depth 1 https://github.com/HackTricks-wiki/hacktricks-cloud.git /opt/kb/HackTricks-Cloud
rm -rf /opt/kb/HackTricks-Cloud/.git

cat > /opt/kb/INDEX.txt <<'EOF'
RioNext Kali knowledge bases (read-only in the master image)

/opt/kb/PayloadsAllTheThings   https://github.com/swisskyrepo/PayloadsAllTheThings
/opt/kb/HackTricks             https://github.com/HackTricks-wiki/hacktricks
/opt/kb/HackTricks-Cloud       https://github.com/HackTricks-wiki/hacktricks-cloud
/opt/nuclei-templates          https://github.com/projectdiscovery/nuclei-templates

Nuclei: nuclei -duc -t /opt/nuclei-templates -u <in-scope host>
ProjectDiscovery httpx is httpx-toolkit (python3-httpx owns /usr/bin/httpx).
Impacket wrappers are /usr/bin/impacket-* (already in kali-linux-headless).
EOF

n_tpl=$(find /opt/nuclei-templates -type f \( -name '*.yaml' -o -name '*.yml' \) | wc -l)
if [ "$n_tpl" -lt 1000 ]; then
  echo "nuclei-templates too small: $n_tpl files" >&2
  exit 1
fi
test -f /opt/kb/PayloadsAllTheThings/README.md
test -e /opt/kb/HackTricks
test -e /opt/kb/HackTricks-Cloud

for b in nuclei katana dalfox cloudfox kerbrute chisel httpx-toolkit; do
  command -v "$b" >/dev/null
done
nuclei -version >/dev/null
echo "extra tools ok; nuclei-templates=$n_tpl"

apt-get clean
rm -rf /var/lib/apt/lists/*
