#!/bin/sh
set -eu
url=$1
if [ -z "$url" ]; then
  echo "usage: rionext-browser URL" >&2
  exit 2
fi
bin=chromium
if ! command -v chromium >/dev/null 2>&1; then
  bin=chromium-browser
fi
# Container is the sandbox. Chromium's own sandbox needs extra kernel features Docker often withholds.
exec "$bin" \
  --headless=new \
  --disable-gpu \
  --no-sandbox \
  --disable-dev-shm-usage \
  --dump-dom \
  "$url"
