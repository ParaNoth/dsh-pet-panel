#!/usr/bin/env bash
# 把本 fork 同步到 DSH profile 的安装副本，让改动立即可用。
#
# 为什么需要它：`dsh plugin add file:<dir>` 对"已存在且未变"的依赖是空操作，
# 而编辑源码会打断 pnpm 建立的硬链接（write 工具是"写新文件再替换"）——两者叠加的结果
# 就是"改了代码但装的是旧的"。这个脚本直接覆盖安装副本，行为确定、可反复执行。
#
# 用法：  bash scripts/sync-to-profile.sh          # 同步
#         bash scripts/sync-to-profile.sh --check  # 只看差异，不写
set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${DSH_PET_TARGET:-$HOME/.dsh/profiles/web/node_modules/dsh-pet}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

if [ ! -d "$TARGET" ]; then
  echo "sync: 目标不存在：$TARGET" >&2
  echo "sync: 先执行  dsh plugin --profile web add file:$FORK_DIR" >&2
  exit 1
fi

# 只同步运行时会加载的部分（素材与 README 等不动，避免无谓的大文件拷贝）
PATHS=(lib/index.js lib/client.js lib/client-link.js runtime/panel runtime/client runtime/electron-helper cordis.patch.yml package.json assets/config.jsonc)

changed=0
for rel in "${PATHS[@]}"; do
  src="$FORK_DIR/$rel"
  dst="$TARGET/$rel"
  [ -e "$src" ] || continue
  if [ -d "$src" ]; then
    if ! diff -rq "$src" "$dst" >/dev/null 2>&1; then
      changed=$((changed + 1))
      echo "  差异: $rel/"
      [ "$CHECK_ONLY" = "1" ] || { mkdir -p "$dst"; cp -R "$src/." "$dst/"; }
    fi
  else
    if ! cmp -s "$src" "$dst" 2>/dev/null; then
      changed=$((changed + 1))
      echo "  差异: $rel"
      [ "$CHECK_ONLY" = "1" ] || { mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"; }
    fi
  fi
done

if [ "$changed" = "0" ]; then
  echo "sync: 已是最新（无差异）"
elif [ "$CHECK_ONLY" = "1" ]; then
  echo "sync: $changed 处有差异（--check 模式未写入）"
else
  echo "sync: 已同步 $changed 处 → $TARGET"
  echo "sync: 重启 dsh web 后生效（宿主代码只在启动时加载）"
fi
