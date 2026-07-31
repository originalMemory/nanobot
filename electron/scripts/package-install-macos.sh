#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "error: package:install:mac 仅支持 macOS" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ARCH="$(node -p 'process.arch')"
BUILT_APP="$ELECTRON_DIR/out/Nanobot-darwin-$ARCH/Nanobot.app"
INSTALL_APP="/Applications/Nanobot.app"
STAGING_APP="/Applications/.Nanobot.app.installing.$$"
BACKUP_APP="/Applications/.Nanobot.app.backup.$$"
EXECUTABLE_PATTERN="/Nanobot.app/Contents/MacOS/nanobot"
INSTALL_COMPLETE=0
REPLACEMENT_STARTED=0

rollback_install() {
  if [[ "$INSTALL_COMPLETE" -eq 0 && "$REPLACEMENT_STARTED" -eq 1 ]]; then
    if [[ -e "$INSTALL_APP" ]]; then
      rm -rf -- "$INSTALL_APP"
    fi
    if [[ -e "$BACKUP_APP" ]]; then
      mv "$BACKUP_APP" "$INSTALL_APP"
    fi
  fi
  if [[ -e "$STAGING_APP" ]]; then
    rm -rf -- "$STAGING_APP"
  fi
}

trap rollback_install EXIT

cd "$ELECTRON_DIR"

echo "[1/6] 打包 Electron"
npm run package

if [[ ! -d "$BUILT_APP" ]]; then
  echo "error: 未找到打包产物：$BUILT_APP" >&2
  exit 1
fi

echo "[2/6] 校验打包产物签名"
codesign --verify --deep --strict --verbose=2 "$BUILT_APP"

echo "[3/6] 准备并校验安装副本"
ditto "$BUILT_APP" "$STAGING_APP"
codesign --verify --deep --strict --verbose=2 "$STAGING_APP"

echo "[4/6] 退出正在运行的 Nanobot"
osascript -e 'tell application id "ai.nanobot.desktop" to quit' >/dev/null 2>&1 || true
for _ in {1..20}; do
  if ! pgrep -f "$EXECUTABLE_PATTERN" >/dev/null; then
    break
  fi
  sleep 0.25
done
if pgrep -f "$EXECUTABLE_PATTERN" >/dev/null; then
  echo "error: Nanobot 仍在运行，请从托盘彻底退出后重试" >&2
  exit 1
fi

echo "[5/6] 安装到 $INSTALL_APP"
REPLACEMENT_STARTED=1
if [[ -e "$INSTALL_APP" ]]; then
  mv "$INSTALL_APP" "$BACKUP_APP"
fi
mv "$STAGING_APP" "$INSTALL_APP"
codesign --verify --deep --strict --verbose=2 "$INSTALL_APP"

echo "[6/6] 启动并确认 Nanobot"
open "$INSTALL_APP"
for _ in {1..40}; do
  if pgrep -f "$EXECUTABLE_PATTERN" >/dev/null; then
    INSTALL_COMPLETE=1
    break
  fi
  sleep 0.25
done
if [[ "$INSTALL_COMPLETE" -ne 1 ]]; then
  echo "error: 新版本启动失败，已恢复旧版本" >&2
  exit 1
fi

if [[ -e "$BACKUP_APP" ]]; then
  rm -rf -- "$BACKUP_APP"
fi
trap - EXIT

echo "完成：$INSTALL_APP"
