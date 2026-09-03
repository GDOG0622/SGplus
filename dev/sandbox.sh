#!/usr/bin/env bash
#
# Boots a throwaway SillyTavern with this extension linked into it, so SGplus
# can be exercised without touching a real installation.
#
#   ./dev/sandbox.sh          # set up if needed, then run
#   ./dev/sandbox.sh reset    # restore default user data, then run
#
# The sandbox lives in .sandbox/SillyTavern and is git-ignored.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SANDBOX="${SGPLUS_SANDBOX_DIR:-$REPO_ROOT/.sandbox}"
ST_DIR="$SANDBOX/SillyTavern"
PORT="${SGPLUS_SANDBOX_PORT:-8719}"
MODE="${1:-run}"

if [ ! -d "$ST_DIR" ]; then
    echo "==> Cloning SillyTavern into $ST_DIR"
    mkdir -p "$SANDBOX"
    git clone --depth 1 -b release https://github.com/SillyTavern/SillyTavern.git "$ST_DIR"
    echo "==> Installing SillyTavern dependencies"
    (cd "$ST_DIR" && npm install --no-audit --no-fund)
fi

cd "$ST_DIR"

if [ ! -f config.yaml ]; then
    echo "==> Writing sandbox config on port $PORT"
    cp default/config.yaml config.yaml
    sed -i.bak "s/^port: .*/port: $PORT/; s/^whitelistMode: true/whitelistMode: false/" config.yaml
    rm -f config.yaml.bak
fi

echo "==> Linking the extension"
mkdir -p public/scripts/extensions/third-party
rm -rf public/scripts/extensions/third-party/SGplus
ln -s "$REPO_ROOT" public/scripts/extensions/third-party/SGplus

# SillyTavern only starts persisting settings once onboarding has finished, so
# pre-complete it. Without this, group changes look fine but never reach disk.
if [ "$MODE" = "reset" ] || [ ! -f data/default-user/settings.json ]; then
    echo "==> Resetting user data"
    mkdir -p data/default-user
    cp default/content/settings.json data/default-user/settings.json
    node -e '
const fs = require("fs");
const path = "data/default-user/settings.json";
const settings = JSON.parse(fs.readFileSync(path, "utf8"));
settings.firstRun = false;
settings.username = "User";
settings.user_avatar = "user-default.png";
settings.main_api = "openai";
fs.writeFileSync(path, JSON.stringify(settings, null, 4));
'
fi

echo "==> SillyTavern with SGplus: http://127.0.0.1:$PORT/"
echo "    Open the AI Response Configuration panel and scroll to Prompts."
exec node server.js
