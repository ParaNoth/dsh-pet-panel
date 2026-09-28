#!/usr/bin/env python3
"""把「会话深链」与「面板设置卡片」注入原客户端 bundle。

为什么必须"注入"而不是"包装 factory"（都是实测结论）：
  * bundle 以 <script> 经典脚本执行，必须是自包含 IIFE —— 顶层 import 会抛
    "Cannot use import statement outside a module"；
  * 同一 bundle 里再 __ModuleLoader__.load 同一 id 会抛 "duplicate factory registration"；
  * 经典脚本顶层没有 require（浏览器里 = undefined），在顶层调用原 factory 会抛
    "require is not a function" 并打断整个 bundle（连宠物本体一起消失）。

四处注入，任一锚点找不到即**报错退出**（绝不静默跳过：静默跳过 = 功能无声失效）：
  1. inject 数组补 "sessions" 与 "settingsScope" —— 深链要 ctx.sessions.open(id)，
     卡片要 ctx.settingsScope 读写 dsh-pet 命名空间；声明为硬依赖后 Cordis 会等它们就绪；
  2. apply 体内末尾插入深链处理（?session=<id> → ctx.sessions.open，带重试）；
  3. apply 体内末尾注册设置卡片（settings.plugin.item，key = dsh-pet 命名空间）；
  4. 卡片本体（scripts/panel-settings-card.js）作为顶层函数插在 factory 之后。

缩进由 I(n) 现算，**不再用文本占位符**：早先用 "TAB" 当占位符做 replace，
碰到「5 个 tab + h:」这种文本时会把 Th 里的字母一起吃掉，产物直接语法错误。现算不会冲突。

用法：inject-deeplink.py <src> <dst>
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CARD_SOURCE = os.path.join(HERE, "panel-settings-card.js")


def I(n):
    """n 级制表符缩进。"""
    return "\t" * n


def indent_block(text, level):
    """
    把一段源码整体挪到给定缩进级别，**保留相对缩进**。

    必须只去掉公共前缀，不能 lstrip 每一行：早先那样写会把 `if (x) {` 与它的函数体
    压成同一层，注入后逻辑结构直接变了（而且语法仍然合法，不报错 —— 最难查的那种）。
    """
    lines = text.strip("\n").split("\n")
    indents = [len(l) - len(l.lstrip("\t")) for l in lines if l.strip()]
    base = min(indents) if indents else 0
    out = []
    for line in lines:
        body = line[base:] if line.strip() else ""
        out.append((I(level) + body) if body else "")
    return "\n".join(out)


# ---------------------------------------------------------------- 注入 1：inject 数组
ANCHOR_INJECT = I(2) + 'const inject = [\n' + I(3) + '"slots",'
INJECT_ADDED = (
    I(2)
    + "const inject = [\n"
    + I(3)
    + "// 由 inject-deeplink.py 注入：深链要 ctx.sessions.open(id)，声明为硬依赖，\n"
    + I(3)
    + "// Cordis 会等它就绪再 apply。\n"
    + I(3)
    + "//\n"
    + I(3)
    + "// settingsScope 故意不在这里：inject 只支持必需依赖（对象形式是「服务名 → 拦截配置」，\n"
    + I(3)
    + "// 没有可选列表）。把设置卡片需要的它写成硬依赖，整个宠物会在缺该服务的宿主里 pending\n"
    + I(3)
    + "// 起不来 —— DSH 桌面版（profile=desktop）的插件树就没有它，实测报\n"
    + I(3)
    + "// `dsh-pet: pending (waiting for service: settingsScope)` 并使 web boot 失败。\n"
    + I(3)
    + "// 卡片改为运行时探测（见 SETTINGS_CARD_SRC），缺服务时静默跳过。\n"
    + I(3)
    + '"sessions",\n'
    + I(3)
    + '"slots",'
)

# ---------------------------------------------------------------- 注入 2：深链处理
DEEPLINK_SRC = """try {
\tvar __dshSid = null;
\ttry { __dshSid = new URLSearchParams(window.location.search).get('session'); } catch (e) {}
\tif (__dshSid) {
\t\t// 打开会话的 API 有两代，**必须优先用 uiWorkspace.openSession**：
\t\t//   * 新版（DSH 桌面版 0.1.7-rc.2 等）：sessions 服务已改版，只有 retain/using/scope 等，
\t\t//     **没有 open()**；选中会话由 uiWorkspace.openSession(id) 承担；
\t\t//   * 旧版（npm 上的 0.1.5-rc.1）：uiWorkspace.openSession 与 sessions.open 都有。
\t\t// 反过来优先 sessions.open 的话，新版会直接抛 `sessions.open is not a function`。
\t\t// 两个都取不到才放弃（并留日志，便于日后 API 再变时定位）。
\t\tvar __dshOpenSession = null;
\t\tvar __dshVia = 'none';
\t\tvar __dshWs = null;
\t\ttry { __dshWs = ctx.get('uiWorkspace'); } catch (e) {}
\t\tif (__dshWs && typeof __dshWs.openSession === 'function') {
\t\t\t__dshOpenSession = function (id) { return __dshWs.openSession(id); };
\t\t\t__dshVia = 'uiWorkspace.openSession';
\t\t} else {
\t\t\tvar __dshSessions = null;
\t\t\ttry { __dshSessions = ctx.sessions; } catch (e) {}
\t\t\tif (!__dshSessions) { try { __dshSessions = ctx.get('sessions'); } catch (e) {} }
\t\t\tif (__dshSessions && typeof __dshSessions.open === 'function') {
\t\t\t\t__dshOpenSession = function (id) { return __dshSessions.open(id); };
\t\t\t\t__dshVia = 'sessions.open';
\t\t\t}
\t\t}
\t\tif (__dshOpenSession) {
\t\t\tconsole.log('[dsh-pet] deeplink: via=' + __dshVia);
\t\t\t// 先清地址参数：避免刷新重复跳转
\t\t\ttry {
\t\t\t\tvar __dshU = new URL(window.location.href);
\t\t\t\t__dshU.searchParams.delete('session');
\t\t\t\twindow.history.replaceState(null, '', __dshU.pathname + __dshU.search + __dshU.hash);
\t\t\t} catch (e) {}
\t\t\t// 等待会话列表就绪再打开：对**不在列表里**的 id 会抛
\t\t\t// `unknown session <id>`，而页面刚加载时列表往往还没拉回来，
\t\t\t// 所以这里轮询重试（最多 25 次 × 400ms ≈ 10s），成功即停。
\t\t\tvar __dshTry = 0;
\t\t\tvar __dshAttempt = function () {
\t\t\t\t__dshTry++;
\t\t\t\ttry {
\t\t\t\t\t__dshOpenSession(__dshSid);
\t\t\t\t\tconsole.log('[dsh-pet] deeplink: opened ' + __dshSid + ' (try ' + __dshTry + ')');
\t\t\t\t} catch (e) {
\t\t\t\t\tif (__dshTry < 25) window.setTimeout(__dshAttempt, 400);
\t\t\t\t\telse console.warn('[dsh-pet] deeplink: gave up after ' + __dshTry + ' tries:', e);
\t\t\t\t}
\t\t\t};
\t\t\twindow.setTimeout(__dshAttempt, 300);
\t\t} else {
\t\t\tconsole.warn('[dsh-pet] deeplink: 找不到可用的会话打开 API（uiWorkspace.openSession / sessions.open 都不可用），已跳过');
\t\t}
\t}
} catch (e) { console.warn('[dsh-pet] deeplink install failed:', e); }"""

# ---------------------------------------------------------------- 注入 3：设置卡片注册
SETTINGS_CARD_SRC = """// ---- 会话面板设置卡片（注入）----
// 目的：把面板总开关与位置放进设置页，用户不必手改 main-config.json。
// 为什么注册到 settings.plugin.item，而不是改宠物自己的「宠物配置」分区：
//   那个分区是上游组件，而本仓库的 lib/client.js 是在上游产物上做源码注入得到的，
//   往它的 JSX 里塞控件要改它的 props 结构，脆得多。这张卡片只依赖公开契约 ——
//   该标签页按 settings 命名空间配对卡片：宿主注册了 dsh-pet 命名空间，这里注册
//   同 key 的卡片即可，双方互不知道对方是什么。
// 用 slots.inject 而不是直接 register：slot 由 ui-settings-plugins 声明，两者激活
//   顺序没有约束，inject 会等 slot 上线再注册（上游卡片也是这么做的）。
try {
	// 运行时探测 settingsScope（不是硬依赖，见 inject 数组处说明）：
	// 宿主没有该服务时跳过设置卡片，宠物本体照常工作。
	var __dshScope = null;
	try { __dshScope = ctx.settingsScope; } catch (e) { __dshScope = null; }
	if (!__dshScope) throw new Error('settingsScope 不可用，跳过设置卡片');
\tvar __dshPanelCard = makePanelSettingsCard({
\t\t// 这里的 h 是 react/jsx-runtime 的 jsx：子节点要放进 props.children
\t\t//（不是 createElement 的第 3+ 个参数），卡片文件里已按此约定书写。
\t\th: h,
\t\tuseState: useState,
\t\tuseEffect: useEffect,
\t\tscope: __dshScope.bind({ namespace: PANEL_SETTINGS_NS })
\t});
\tctx.slots.inject("settings.plugin.item", function* () {
\t\tyield ctx.slots.register({
\t\t\tname: "settings.plugin.item",
\t\t\tkey: PANEL_SETTINGS_NS
\t\t}, __dshPanelCard);
\t});
} catch (e) { console.warn('[dsh-pet] settings card install failed:', e); }"""

# ---------------------------------------------------------------- 注入 3.5：面板点击的轮询通道
# 为什么需要它（桌面版场景）：
#   面板点击时走 shell.openExternal 打开 `?session=<id>` 会**跳出到系统浏览器**，因为 DSH 桌面
#   App 的 URL scheme 只处理 `dsh://open`（聚焦窗口），没有会话级深链。
#   所以桌面版改为：面板 POST /open-session 登记目标 → **已连在这个宿主上的页面**（就是 App 自己的
#   窗口）轮询领取 → 调 openSession 切过去。这样点击就留在 App 内，不打开浏览器。
#   与深链通道并存、互不冲突：同一标签页内由本通道切；地址栏带参时由深链兜底。
POLL_SRC = """// ---- 面板→页面 的会话切换通道（轮询）----
// 面板把「要打开的会话」POST 给宿主 /open-session，这里轮询领取并在页面内在切换。
// 用轮询而不是 WebSocket/SSE：宿主侧只需一个内存变量 + 一个 GET 端点，最不容易坏。
var __dshOpenSessionForPanel = null;
try {
\tvar __dshWs = null;
\ttry { __dshWs = ctx.get('uiWorkspace'); } catch (e) {}
\tif (__dshWs && typeof __dshWs.openSession === 'function') {
\t\t__dshOpenSessionForPanel = function (id) { return __dshWs.openSession(id); };
\t} else {
\t\tvar __dshSessions = null;
\t\ttry { __dshSessions = ctx.sessions; } catch (e) {}
\t\tif (__dshSessions && typeof __dshSessions.open === 'function') {
\t\t\t__dshOpenSessionForPanel = function (id) { return __dshSessions.open(id); };
\t\t}
\t}
} catch (e) {}
if (__dshOpenSessionForPanel) {
\tvar __dshOpenEndpoint = '/dsh-pet-7340/open-session';
\t/** 已处理过的 nonce：同一次请求只切一次（宿主在 ack 之前会重复返回同一条） */
\tvar __dshLastNonce = null;
\tvar __dshPollBusy = false;
\tvar __dshPollTick = function () {
\t\tif (__dshPollBusy) return;
\t\t__dshPollBusy = true;
\t\tfetch(__dshOpenEndpoint, { cache: 'no-store' }).then(function (res) {
\t\t\tif (!res.ok) throw new Error('HTTP ' + res.status);
\t\t\treturn res.json();
\t\t}).then(function (data) {
\t\t\t__dshPollBusy = false;
\t\t\tvar id = data && data.sessionId ? String(data.sessionId) : null;
\t\t\tvar nonce = data && data.nonce ? String(data.nonce) : null;
\t\t\tif (!id || !nonce || nonce === __dshLastNonce) return;
\t\t\t__dshLastNonce = nonce;
\t\t\ttry {
\t\t\t\t__dshOpenSessionForPanel(id);
\t\t\t\tconsole.log('[dsh-pet] panel open: ' + id);
\t\t\t} catch (e) {
\t\t\t\tconsole.warn('[dsh-pet] panel open failed:', e);
\t\t\t\treturn; // 失败不 ack：下次轮询会重试同一条
\t\t\t}
\t\t\t// ack：让宿主清掉待打开状态（否则每次轮询都会重复切）
\t\t\tfetch(__dshOpenEndpoint + '?ack=' + encodeURIComponent(nonce), { cache: 'no-store' }).catch(function () {});
\t\t}).catch(function () {
\t\t\t// 宿主不可达（重启中/CLI 未启动）：静默重试，面板功能不受影响
\t\t\t__dshPollBusy = false;
\t\t});
\t};
\twindow.setInterval(__dshPollTick, 1000);
\tconsole.log('[dsh-pet] panel open channel started (poll every 1000ms)');
} else {
\tconsole.warn('[dsh-pet] panel open channel: 找不到可用的会话打开 API，已跳过');
}"""

# ---------------------------------------------------------------- 注入 4：卡片本体
CARD_ANCHOR = "//#region src/client/index.ts\nwindow.__ModuleLoader__.load({"
CARD_HEAD = "//#region dsh-pet 面板设置卡片（注入自 scripts/panel-settings-card.js，勿手改此处）\n"
CARD_TAIL = "\n//#endregion\n" + CARD_ANCHOR

# 注入后必须出现的标记（少一个就说明某处注入没生效）
MARKERS = (
    "makePanelSettingsCard",
    "panel open channel started",
    "PANEL_SETTINGS_NS",
    '"sessions",',
    "__dshScope",
    "settings.plugin.item",
    "URLSearchParams(window.location.search)",
)


def locate_apply_end(lines):
    """返回 apply 闭合行的下标；用三行序列唯一定位（内层工厂里也有 module.exports）。"""
    for i in range(len(lines) - 2):
        if (
            lines[i].rstrip() == I(3) + "});"
            and lines[i + 1].rstrip() == I(2) + "}"
            and lines[i + 2].rstrip() == I(2) + "module.exports = {"
        ):
            return i + 1
    return None


def main():
    if len(sys.argv) != 3:
        sys.stderr.write("usage: inject-deeplink.py <src> <dst>\n")
        return 2
    src, dst = sys.argv[1], sys.argv[2]
    text = open(src, encoding="utf-8").read()

    # 幂等保护：已注入过的产物不要再注一次（否则 inject 数组重复、卡片注册两次）
    if "makePanelSettingsCard" in text or "__dshPanelCard" in text:
        sys.stderr.write("inject-deeplink: 目标已含注入内容，请从 lib/client.base.js 重新构建\n")
        return 1

    # ---- 注入 1：inject 数组 ----
    if ANCHOR_INJECT not in text:
        sys.stderr.write("inject-deeplink: 未找到 inject 数组锚点，注入中止\n")
        return 1
    text = text.replace(ANCHOR_INJECT, INJECT_ADDED, 1)

    # ---- 注入 2 + 3：apply 体末尾 ----
    lines = text.split("\n")
    at = locate_apply_end(lines)
    if at is None:
        sys.stderr.write("inject-deeplink: 未找到 apply 闭合行，注入中止\n")
        return 1
    block = (indent_block(DEEPLINK_SRC, 4) + "\n" + indent_block(POLL_SRC, 4) + "\n" + indent_block(SETTINGS_CARD_SRC, 4)).split("\n")
    lines = lines[:at] + block + lines[at:]
    text = "\n".join(lines)

    # ---- 注入 4：卡片本体 ----
    if not os.path.exists(CARD_SOURCE):
        sys.stderr.write("inject-deeplink: 缺少 %s\n" % CARD_SOURCE)
        return 1
    card = open(CARD_SOURCE, encoding="utf-8").read().rstrip("\n")
    if CARD_ANCHOR not in text:
        sys.stderr.write("inject-deeplink: 未找到模块加载段锚点，卡片本体注入中止\n")
        return 1
    text = text.replace(CARD_ANCHOR, CARD_HEAD + card + CARD_TAIL, 1)

    # ---- 自检 ----
    for marker in MARKERS:
        if marker not in text:
            sys.stderr.write("inject-deeplink: 注入后缺少标记 %s\n" % marker)
            return 1
    # settingsScope 不能是硬依赖：可选能力，声明成必需会让缺该服务的宿主整个宠物 pending
    if '"settingsScope",' in text:
        sys.stderr.write("inject-deeplink: settingsScope 不能作为硬依赖出现在 inject 数组\n")
        return 1
    if "__dshScope" not in text:
        sys.stderr.write("inject-deeplink: 设置卡片缺少 settingsScope 运行时探测\n")
        return 1

    open(dst, "w", encoding="utf-8").write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
