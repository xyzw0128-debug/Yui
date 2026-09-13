#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${1:-$HOME/NanoClaw}"
NANOCLAW_REPO="https://github.com/nanocoai/nanoclaw.git"

echo "=================================================="
echo "💙 Yui_NanoClaw Carry Layer Setup & Installer"
echo "=================================================="
echo "Target directory: $TARGET_DIR"

# 1. Clone or update upstream NanoClaw
if [ ! -d "$TARGET_DIR/.git" ]; then
  echo "[1/4] Cloning official NanoClaw upstream..."
  git clone "$NANOCLAW_REPO" "$TARGET_DIR"
else
  echo "[1/4] Found existing NanoClaw directory at $TARGET_DIR."
fi

# 2. Apply Yui carry patch
echo "[2/4] Applying Yui carry patch..."
cd "$TARGET_DIR"
if git apply --check "$SCRIPT_DIR/patches/yui-carry.patch" >/dev/null 2>&1; then
  git apply "$SCRIPT_DIR/patches/yui-carry.patch"
  echo "      -> Patch applied successfully."
else
  echo "      -> Patch already applied or partially matched, skipping."
fi

# 3. Copy Yui-exclusive source components
echo "[3/4] Copying Yui exclusive components (Model Console & Progress Card)..."
cp "$SCRIPT_DIR/src/channels/discord-model-console.ts" "$TARGET_DIR/src/channels/"
cp "$SCRIPT_DIR/src/channels/discord-model-console.test.ts" "$TARGET_DIR/src/channels/"
mkdir -p "$TARGET_DIR/src/modules/progress-card"
cp -r "$SCRIPT_DIR/src/modules/progress-card/"* "$TARGET_DIR/src/modules/progress-card/"

# Create .env from template if missing
if [ ! -f "$TARGET_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$TARGET_DIR/.env"
  echo "      -> Created .env from template. Please configure your tokens!"
fi

# 4. Install dependencies
echo "[4/4] Installing dependencies via pnpm..."
pnpm install

echo "=================================================="
echo "✨ Yui_NanoClaw setup completed successfully!"
echo "To start Yui:"
echo "  cd $TARGET_DIR"
echo "  pnpm build"
echo "  bash nanoclaw.sh"
echo "=================================================="
