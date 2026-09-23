#!/usr/bin/env bash
# 生成 lib/client.js = 原 bundle（lib/client.base.js）+ 会话深链注入（见 inject-deeplink.py）。
#
# 为什么是"注入"而不是分层 import：
#   加载器用 <script> 执行 bundle，整个文件必须是**自包含 IIFE** —— 顶层 import 会直接抛
#   "Cannot use import statement outside a module"；在同一 bundle 里再 __ModuleLoader__.load
#   同一个 id 又会触发 "duplicate factory registration"。
#
# 为什么深链注入在 apply 内部（而不是包装 factory）：
#   经典 script 顶层没有 require（浏览器里 = undefined），一旦在顶层调用原 factory 就会抛
#   "require is not a function" 并打断整个 bundle —— 连宠物本体都会一起消失（实测踩过）。
#   注入进 apply 则天然有 ctx，且与模块注册/加载时序完全无关。
#
# 注入由 scripts/inject-deeplink.py 完成：找不到锚点**报错退出**，绝不静默跳过
#（静默跳过 = "功能没生效"变成无声故障，这正是前面几轮排查最耗时的地方）。
set -euo pipefail

FORK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE="$FORK_DIR/lib/client.base.js"
OUT="$FORK_DIR/lib/client.js"

[ -f "$BASE" ] || { echo "build-client: 缺 $BASE（原始 bundle 备份）" >&2; exit 1; }

python3 "$FORK_DIR/scripts/inject-deeplink.py" "$BASE" "$OUT"
chmod 644 "$OUT"
echo "build-client: 已生成 $OUT (bytes: $(wc -c < "$OUT" | tr -d ' '))"
