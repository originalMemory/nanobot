#!/bin/sh
dir="$HOME/.nanobot"
if [ -d "$dir" ] && [ ! -w "$dir" ]; then
    owner_uid=$(stat -c %u "$dir" 2>/dev/null || stat -f %u "$dir" 2>/dev/null)
    cat >&2 <<EOF
Error: $dir is not writable (owned by UID $owner_uid, running as UID $(id -u)).

Fix (pick one):
  Host:   sudo chown -R 1000:1000 ~/.nanobot
  Docker: docker run --user \$(id -u):\$(id -g) ...
  Podman: podman run --userns=keep-id ...
EOF
    exit 1
fi
# compose 以 PUID 运行时 /home/nanobot 属主为镜像内 uid 1000，不可写；git 配置放到可写的 .nanobot
export GIT_CONFIG_GLOBAL="$HOME/.nanobot/gitconfig"
git config --global --add safe.directory /home/nanobot/src 2>/dev/null || {
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=safe.directory
    export GIT_CONFIG_VALUE_0=/home/nanobot/src
}

bootstrap="$HOME/.nanobot/workspace/bin/bootstrap.sh"
if [ -f "$bootstrap" ]; then
    bash "$bootstrap" || exit 1
fi
exec nanobot "$@"
