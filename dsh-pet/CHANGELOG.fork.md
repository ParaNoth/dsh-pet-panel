# 变更记录（相对上游 dsh-pet）

## 〇、仓库与血缘

本仓库是 [`PC2005-cloud/dsh-pet`](https://github.com/PC2005-cloud/dsh-pet) 的 fork，
用上游的 **monorepo 结构**：包本体在 `dsh-pet/` 子目录，仓库根保留上游的 `prompts/`、`tools/`、`video/` 等。

本 fork 的改动是**一个提交**，直接落在上游 `main` 之上 —— 所以：

- GitHub 上显示为正常的 fork，diff 只包含本 fork 的改动；
- 上游有更新时可以 `git fetch upstream && git merge upstream/main`；
- 本 fork 接的上游基点是含 `issue #56`（宿主退出后 helper 卡死）与 `issue #60`（黑屏注释修正）的 `main`，
  比最初 fork 时用的 npm v0.2.11 多这两个修复。

> 为什么是"一个提交"而不是原来的十来个：原先的仓库是在**包这一层**初始化的（仓库根 = 包根），
> 与上游 monorepo 层级不同、没有共同祖先。为了让 fork 关系成立、能跟上游同步，
> 改为把最终状态作为单个提交 graft 到上游 `main` 之上。逐条开发历史保留在本地分支
> `backup-flat-e3bdb26`（以及原 fork 目录的历史）里，需要时可查。

---

# 变更记录（相对上游 dsh-pet v0.2.11）

本文件记录这个 fork 做了什么、以及**为什么**这么做 —— 尤其是那些踩过坑才定下来的取舍，避免日后重复走弯路。

---

## 一、功能：会话面板

### 1. 面板本体（`runtime/electron-helper/sessions-panel.js`，新增）

与宠物**同一个窗口**里的 DOM 组件（方案 A）。为什么不独立窗口：

- 独立窗口需要跨进程同步位置（写锚点文件 + 轮询跟随），是第一版方案，能跑但复杂；
- 同窗口内它就是普通 DOM，跟随宠物移动/跨屏/挤压全自动，一行跨进程代码都不需要；
- 代价是面板矩形要纳入窗口命中区（见第 3 条），而这本来就有现成机制（宠物右键菜单/对话弹窗走同一套）。

### 2. 面板数据源（`lib/index.js`：`GET /dsh-pet-7340/sessions`）

每个活动会话一行。宿主内部本来就有 `workStatusBySession`（按会话记录状态），但对外只暴露"优先级最高的那一个"聚合态 —— 面板要的是**每个会话各自一行**，所以：

- 新增 `/sessions` 端点，输出 `{id, state, project, task, workText, todoDone, todoTotal}`；
- 补上 per-session 的任务/待办追踪（原来 `workStatus.task` 只记录"当前展示会话"的文案）；
- `workText` = "宠物本来会显示的那句状态文案"：优先任务详情（todo），否则取配置 `workStatusTexts` 该档位的随机一句 —— 与浏览器/桌面两种壳的取值逻辑一致。

> **踩坑**：`workStatusTexts` 是**条目级顶层字段**（`merged.main.workStatusTexts`），不在 `pets[i]` 里。一开始读成 `pets[0].workStatusTexts`，永远取不到 → 面板一直显示「（空闲）」。验证方法很土但有效：直接打印合并后配置的 keys。

### 3. 点击跳转会话（`lib/client.js` 注入 + `lib/index.js` 握手端点）

DSH 前端**没有 URL 深链**（`URLSearchParams` / `location.hash` / `history.replaceState` 在源码里除测试外零命中）。所以两段式：

```
面板点击 → ① POST /open-session（宿主记下"待打开"）
         → ② 打开 http://127.0.0.1:3080/?session=<id>
              → 页面加载时，注入的客户端代码读参数 → ctx.sessions.open(id)
```

客户端切换由 `lib/client.js` 里的注入代码完成（见第三节）。

### 4. 关闭 / 恢复 / 余额行 / 通知持久

| 功能 | 关键决定 |
|---|---|
| × 关闭 | **纯内存**记录，重启即清。曾用 localStorage 持久化，结果是"关掉的会话在刷新后仍被过滤掉 → 面板整块消失"（用户三次反馈"框体不见了"）。面板的存在感比"记住关闭"更重要 |
| ⟲ 恢复 | 清空关闭记录，被 × 掉的行全部回来。没有它，误关后无自救入口 |
| 空态提示 | 全部关闭时显示「已全部关闭 · 点 ⟲ 恢复」，**不整块消失**（消失会让人以为面板坏了） |
| 余额行 | `id = __balance__` 的普通行（`session = null` 的等价物），复用同一套渲染/关闭/恢复。好处：刷新后至少有个框，不必先发消息才能看到面板 |
| 通知持久 | 面板关闭记录**永不自动过期**；宿主终态保留 60s → 24h。用户要求"只有被关掉才消失，自动蒸发会让提醒失效" |

> **踩坑（同一类错误踩了三次）**：任何"过滤后为空就隐藏"的逻辑都会让面板变空气。现在：关闭记录纯内存 + 空态提示 + 判据用"候选总数（余额行 + 会话行）"而不是会话数。

---

## 二、宠物窗口渲染端的改动

| 文件 | 改动 | 原因 |
|---|---|---|
| `constants.js` | 新增 `__dshPetInteractiveRegions` 注册表 + `interactiveRegionAt()` | 窗口默认**整窗点击穿透**，只有"光标在宠物身体命中区"时才翻转为可交互。面板是普通 DOM，必须能被点 → 让组件自己登记"光标是否落在我身上"，避免 sprite 硬编码认识每个组件 |
| `sprite.js` | ① 命中判定纳入登记区 ② 命中面板时上报 `setInputBusy(true)` ③ `--pet-size` 同时设到根元素 | ① 让面板可点；② 主进程有条兜底轮询（每 60ms 按真实光标位置判定），它**只认宠物身体** —— 光标停面板上时会把窗口翻回穿透，点击就落不到 DOM（现象：悬停会亮、点击无反应）。`setInputBusy` 是宠物菜单/对话弹窗一直在用、已验证可点的那条通道；③ 面板挂在 `body` 下，是 `.pet-sprite` 的兄弟节点，读不到它身上的 `--pet-size`，导致所有 `calc(var(--pet-size)…)` 失效、面板塌成"一条很窄的长条" |
| `renderer.js` | 实例化面板 + `__dshPetBubbleEnabled = false` | 面板承接了气泡的内容，关掉气泡可把宠物头顶空间让给面板（面板因此能贴近宠物头部） |
| `index.html` | 面板样式（深色毛玻璃）+ 挂载脚本 | 尺寸全部跟 `--pet-size` 等比，换宠物大小不用改样式 |

### 面板几何

```
窗口 = 宠物包围盒 + 四周余量（左右/下 = 0.5×宠物宽；顶部 = 0.25×，因为气泡已关）
  ├─ 面板：top = --sess-panel-top，left = --sess-panel-left，宽 = min(180px, --sess-avail-w)
  └─ 宠物：画布顶边 = margin.t
```

**不要**用"加高窗口"给面板腾空间 —— 试过：窗口加高 204px 后，宠物往上移动时窗口顶边先撞屏幕边缘，体感是"被顶住"。

#### 面板位置：居中优先，越界平移（`SessionsPanel.reposition()`）

需求经历过一次方向性修正，两版都写在这里，因为第二版的理由比第一版更本质：

- 第一版理解成「超出屏幕边缘时往回收」，于是实现为**贴边换边**（面板贴在宠物身体左/右侧）；
- 实测反馈是「**这个窗口直接偏了**」—— 换边是「贴在某一侧」的排版，结果永远偏在一边。
  用户真正要的是 **优先居中，其次不越界**，也就是 `clamp(居中位置, 边界)`，不是换边。

居中优先还有一个额外好处：夹取只平移、不压缩，所以面板宽度可以固定，
行内文字不会因为贴边而被挤成两行。

关键是先搞清楚"谁会越界"：窗口**不夹取**（`sendBounds` 直接下发位置，漫游/拖拽的边界只按宠物**身体**算，
`sideAllow = 0.25×size`），所以宠物贴边时窗口会跟着越出屏幕、被 OS 裁掉一角 —— 被裁的正是贴着窗口
边缘的面板。结论：**边界只能以工作区（`AREAS`）为准，且锚点必须算成窗口内坐标**，不能写死在 CSS 里
（写死 `50vw` 的锚点在窗口被裁时会跟着偏，见下面第二个坑）。

做法（`index.html` 只消费 `reposition()` 下发的变量，不参与判定）：

| 变量 | 含义 |
|---|---|
| `--sess-panel-left` | 面板左缘距窗口左缘 = `clamp(居中位置, 下界, 上界) − 窗口左缘` |
| `--sess-panel-top` | 垂直位置（宠物贴顶边时下移，原先会连同面板一起被裁） |
| `--sess-avail-h` | 工作区剩余高度，与「顶部余量」一起给 `max-height` 取 min |

- 位置一律用**窗口内坐标 + `left`** 表达（右缘锚点在窗口被裁时会算出负数）。
- 居中的理想位置 = `宠物中心 − 面板宽/2`（屏幕坐标）。
- 下界 = `max(窗口左缘, 工作区左缘) + EDGE_PAD`，上界 = `min(窗口右缘, 工作区右缘) − 面板宽 − EDGE_PAD`。
  **两重边界都要**：落在窗口外的部分被 OS 裁掉（看不见），落在工作区外的部分出屏。
- 上界小于下界（窗口窄到放不下面板）时取「离居中最近」的可行值，宁可略微出界也不产生负宽度。
- 宽度**固定 180px**：夹取只平移不压缩，所以贴边时行内文字不会换行、状态词不会挤成两行。

> **坑 1（判据用错坐标系）**：第一版用"宠物身体**在窗口内**的位置"算可用宽度。但窗口左缘
> ≡ 宠物包围盒左缘 − `margin.l`，所以身体在窗口内**永远**距左缘 `margin.l` —— 算出来是恒定值，
> 于是永不换边（贴到哪一侧都不动）。**判据必须是宠物在屏幕上的位置。**
>
> **坑 2（锚点跟着窗口被裁）**：第二版改成"两侧余量比较 + 换 CSS class"，方向是对的，但默认方位的
> 锚点写死在 CSS（`right: calc(50vw − 0.1size − 6px)`）。宠物越过屏幕右缘后窗口被裁、`50vw` 跟着变，
> 面板就飘到屏幕外了（实测 `roomL/R` 是 1506/−1554 这种离谱值才发现）。
> 修法：锚点由 JS 算成窗口内坐标下发，CSS 只做消费。
>
> 验证方式：写一个纯 Node 脚本复刻 `reposition()` 的公式 + CSS 的消费方式，把宠物从最左扫到最右
> （逐像素 ~2965 步），断言每一步「面板完整可见」且「居中时偏移为 0」。实测：居中场景偏移 0px，
> 贴边最多平移 94px（约半个面板宽），全程无一处出屏。

> **坑 3（字段名不一致，最贵的一个）**：`AREAS` 的元素是 `{x, y, width, height}`
>（shared-core 的 `translateRects` 生成），而 `VIEW` 是 `{x, y, w, h}` —— **两套命名**。
> 我按 `VIEW` 的习惯写了 `wa.x + wa.w`，得到 `NaN`；`NaN` 让所有比较恒为 false，
> 于是面板落进"离居中最近的可行位置"那个退化分支，表现为**整块偏在窗口左边**。
>
> 真正致命的不是这个 bug，而是**我的验证脚本把真 bug 掩盖了两轮**：脚本里自己写了个
> `resolveRect` 桩，返回的正是 `{x, y, w, h}`,于是每次都算出"居中偏移 0px ✅"。
> 桩的数据形态与真实数据不一致时，**验证是负资产** —— 它比没有验证更糟，因为你会相信它。
>
> 修法：读宽高统一走 `rectSize(rect, 'w'|'h')`（两种命名都认），并加了
> `scripts/test-panel-geometry.mjs` 做回归守卫 —— 它的 `AREAS` 一律用 `width/height`
> 真实形态、直接 eval 真实实现（不复制公式），并且**做过变异测试**：
> 把修复退回去，测试必须变红（实测 8 项失败、扫描出 1373 处异常）。

> **顺带删掉的东西**：改成夹取之后，设置项 `side`（自动/左/右）三个值的行为完全一样了 ——
> 于是把它从 schema、卡片、渲染端一起删掉，只留 `enabled`。这跟 `corner` 是同一种病：
> **留着一个不起作用的设置，比没有这个设置更糟**（用户会以为改了没生效，然后开始怀疑整个功能）。

---

## 二·五、面板设置接进 DSH 设置页

需求原话是"把 `petPanel` 的开关和角落接进设置页"。做之前先查了一下，发现两件事：

1. **`petPanel` 是死配置** —— `grep -rn petPanel lib/ runtime/` 零命中，写了没人读；
2. **`corner` 已经没有意义** —— 面板并入宠物窗口之后它始终跟着宠物走（贴边还会自动换边），
   不存在"面板固定在屏幕某个角落"这回事。

所以先跟用户确认了设置项的内涵，当时定为 **总开关 + 面板在宠物哪一侧（自动/左/右）**。
后来位置方案改成「居中优先 + 越界平移」（见上一节），`side` 的三个值行为变得完全一样，
于是**只保留总开关** —— 理由见上一节末尾那条。

### 设置页的渲染规则（决定了实现形态）

`设置 → Plugins → Plugin configuration` 标签页渲染的是**两个账本的交集**：

- 宿主侧：注册了 settings 命名空间的插件（`ctx.settings.register` / `installSection`）；
- 浏览器侧：往 `settings.plugin.item` 这个 **keyed slot** 注册了同 key 卡片的插件，key = 命名空间名。

标签页自己不认识任何一个命名空间 —— 它只按 key 派发。所以接一个设置项 = 宿主注册命名空间 +
浏览器注册同 key 卡片，两边互不知道对方是什么。

### 三个决定

| 决定 | 理由 |
|---|---|
| 命名空间名 `dsh-pet` | 必须是小写连字符标识；同时就是卡片注册的 key。已确认部署里没被占用（现有：`ui-theme` / `shell` / `agent-loop` / `permission` / `agent-presets` / `subagent-model-selection` / `agent-default-model` / `web-search-deepseek` / `ui-chat` / `ui-conversation` / `ui-onboarding` / `locale`） |
| 卡片注册进 `settings.plugin.item`，**不改**宠物自己的「宠物配置」分区 | 那个分区是上游组件，而本仓库的 `lib/client.js` 是在上游产物上做源码注入得到的。往它的 JSX 里塞控件要改它的 props 结构，脆得多；新卡片是独立分支，只依赖公开的 slot/scope 契约 |
| settings 服务用 `ctx.inject(['settings'], …)` 等，**不放进** `inject` 数组 | 它是可选依赖：部署没挂 `dsh-settings-file` 时不应让整个宠物插件卡在 waiting。缺席时 `petPanelValue()` 恒返回文件里的基准值，行为与接设置页之前完全一致 |

### 两层来源与合并顺序

```
schema 默认 {enabled:true, side:'auto'}
  ← base：main-config.json 的 petPanel（老用户在这里写过的值仍然有效）
  ← user：设置页写入 settings.yaml 的覆盖层
```

合并落在**唯一一个**读配置的出口 `readAllConfig(paths, panel)` 里（内部是 `readAllConfigRaw` + 覆盖），
而不是散落到各处调用点 —— 否则将来有人新增一处读配置却漏掉覆盖，表现就是"设置页改了没反应"，
极难查。

> **踩坑**：schemastery 的 object **不会剔除未知键**。实测 `z.object({enabled, side})({enabled, corner})`
> → `{enabled, side:'auto', corner}` —— 旧的 `corner` 会一路带进 settings.yaml 的 base 层。
> 所以加了一个显式挑字段的 `normalizePetPanel()`。

### 两条链路的时延

- 设置页 → 宠物：宿主 `onChange` 里 `syncDesktop()` 重启 Helper（渲染端只在启动时读一次 `/config`），
  所以是**秒级**生效。用**值比较**做去重：`installSection` 挂载时会立刻回调一次（值没变）、
  摘除时也会回调（服务已走），不做去重就会每次插件加载白重启一次宠物。
- 设置页（或文件）→ 面板：面板自己的 `refreshSettings()` 跟着会话轮询（1.5s）读 `/config`，
  所以不必等 Helper 重启也能生效；`enabled=false` 时**连 `/sessions` 请求一起停**。

> **踩坑**：`side` 变化不会移动宠物，于是 `reposition()` 的去重键（位置）不变 → 主动重算会被跳过。
> 修法是先清 `_posKey` 再调 `reposition()`。

### 客户端注入的两处新坑（都在 `scripts/`）

1. **占位符不能是字母串**。原来用 `"TAB"` 当制表符占位符做 `replace`，这次要表达
   「5 个 tab + `h:`」，字符串是 `TABTABTABTABTABTh: h` —— `replace` 把 `Th` 里的 `TAB`
   也换掉了，产物变成 `\t\t\t\t\th: h`，语法直接报错。改成 `I(n)` 现算缩进，彻底不可能冲突。
2. **整体缩进必须只去公共前缀**。`indent_block()` 一开始对每行 `lstrip("\t")`，把
   `if (x) {` 和它的函数体压成同一层 —— **语法仍然合法、不报错**，但逻辑结构已经变了。
   改成先求各行最小缩进、只去掉这个公共前缀。

另外 `h` 在这个注入点不是 `createElement` 而是 `react/jsx-runtime` 的 `jsx`：
**子节点要放进 `props.children`**，不是第 3+ 个参数。

### 验证方式

没有浏览器可控，所以用 Node 把三端都单独跑起来验：

| 验什么 | 怎么验 |
|---|---|
| 宿主命名空间 | 挂**真实** `dsh-settings-file` + 临时 `settings.yaml`，验 base 层、写入回调、非法值被拒、`replace({})` 回退 |
| 客户端卡片 | 注入一个可观察的 `scope`，验写入调用、`loading`/`unavailable` 两态文案、非法 `side` 兜底 |
| 整个 bundle | 桩掉 `__ModuleLoader__`/`require('react')`/DOM，验模块注册 → `apply` 执行 → 卡片注册（key 正确）→ 组件渲染出中文文案 |

---

## 二·六、修「宠物用久了卡在工作中，不再接收状态更新」

用户报告：宠物跑久了会一直停在"工作中"，之后不再响应新的状态更新。

### 排查过程（值得记：三次判断，前两次都被证据推翻）

1. 先怀疑**缺 `turn/end`**：读上游 `dsh-agent-loop` 发现 `turn/end` 在 `finally` 里 append，
   每条 `turn/start` 必有配对 —— **不是这个原因**。
2. 再怀疑**僵尸条目**（会话没了、状态还留着）：离线按宿主规则重放会话记录，
   10 个会话里唯一的 `working` 就是当时正在跑的会话 —— **也不是这个原因**。
3. 最后定位到**优先级 + TTL 的组合**：

```
WORK_STATUS_PRIORITY = { waiting:60, error:50, working:40, thinking:30, result:25, success:20 }
```

`working`(40) 高于 `thinking`(30)/`result`(25)/`success`(20)。所以只要有**一条**残留的
`working`，它就会压住其他所有会话的状态更新，而它自己最长能留 **24 小时**（`TERMINAL_KEEP_MS`）
—— 表现完全就是"卡在工作中，不接收新状态"。

残留是怎么来的（`scheduleTerminalCleanup` 的旧写法）：

```js
if (terminalTimers.has(sessionId)) return;        // 一次性
const t = setTimeout(() => {
  terminalTimers.delete(sessionId);               // ← 回调开头就删了
  if (entry.state === 'success' || entry.state === 'error') { ...删除条目... }
}, TERMINAL_KEEP_MS);
```

计时器到点时若条目已变成 `working`（这 24h 内会话又活动过），就**不删条目**、当次也不再武装 ——
于是它一直留着，直到该会话下次到达终态才被重新武装、再等满 TTL。

> ⚠️ 更正一条我先前的错误结论：一度以为这是"永久泄漏"。**变异测试证明不是** ——
> 因为 `has()` 的判断发生在回调 delete **之后**，所以下次仍能重排。真实影响是
> "最长 24 小时的展示冻结"，不是永久。**别把没验证过的机制写进注释**，会误导后来人。

### 修复（三层）

| 层 | 做法 |
|---|---|
| 1. 陈旧在途状态降级 | `STALE_INFLIGHT_MS = 30min`：超过 30 分钟没有任何更新的 `working`/`thinking` 在**优先级判据里**降为 `result`（仍显示，但不再霸占最高优先级）。只降级不删条目 —— 会话可能真卡住，删了会丢信息 |
| 2. 计时器可重排 | 每次到达终态都 `clearTimeout` 旧的再排新的；回调只在"排定之后没有任何更新"时清理（`entry.updatedAt <= armedAt`） |
| 3. 会话销毁即刻清理 | 订阅 `session/disposed`（会话真正离开会话表 = 权威"已死"信号），立刻丢弃其状态，不必等 TTL |

外加一层防御：`/sessions` 里顺手剔除 `ctx.sessions` 已不认识的会话（拿不到会话服务时跳过，
宁可不删也不误删）。

回归测试：`scripts/test-terminal-cleanup.mjs`（`npm run test:all`）—— 从 `lib/index.js` 里
**抽出真实的 `scheduleTerminalCleanup` / `dropSessionState`** 跑，不复制公式；注入可控时钟避免
同毫秒抖动。已做变异测试：退回旧写法必须变红。

> **测试自身也踩过坑**：第一版断言用的是"活动计时器数组"，而 `fireAll()` 会把数组清空 →
> 断言恒为 0、旧实现也能"通过"（假阳性）。改成直接断言 `terminalTimers` 这个 Map 才抓得住。

---

## 三、客户端 bundle 的注入方案（`scripts/`）

### 为什么是注入而不是重新构建

上游发布包**不含构建配置**（`tsdown.config.ts` / `tsconfig.json` 都不在 tarball 里），无法用原流水线重建 `lib/client.js`。所以：`lib/client.base.js` = 上游原 bundle 原样备份，`scripts/inject-deeplink.py` 对它做两处注入。

### 两处注入

1. **`inject` 数组补 `"sessions"`** —— 深链要调 `ctx.sessions.open(id)`。声明为硬依赖后 Cordis 会**等该服务就绪再 apply**；用 `ctx.get('sessions')` 在 apply 时往往取到 `undefined`（服务还没注册）。
2. **`apply` 函数体内插入深链处理** —— 读 `?session=` → `ctx.sessions.open(id)`，带等待型重试。

### 走过的三条死路（都实测失败，勿重复）

| 方案 | 失败原因 |
|---|---|
| 包装层用 `import` 引入逻辑 | bundle 以经典 `<script>` 执行，顶层 import 直接抛 `Cannot use import statement outside a module`，**整个 dsh.client 加载失败**（连宠物一起消失） |
| 取走 `pendingQueue` 里的注册项再自己 `load` | 同一 id 注册两次 → `duplicate factory registration`；加载器排空队列的时机与脚本执行无法从 bundle 内部保证 |
| 在**顶层**调用原 factory（`makeFactory(require)`） | 经典脚本顶层没有 `require`（浏览器里 = `undefined`）→ 抛 `require is not a function`，**打断整个 bundle**。这是最隐蔽的一个：宠物本体照常渲染（它的 factory 由加载器调用，require 正常），但注入代码从未跑到 |

> 教训：**注入点在 `apply` 函数体内**（那里一定有 `ctx`）。定位时用三行精确序列 + 结构校验，别按"第一个 `module.exports`"匹配 —— 内层 factory 里也有一个。

### `ctx.sessions.open()` 的行为

```js
select(sessionId) {
  if (!this.summaries.some(s => s.id === sessionId)) {
    throw new Error(`sessions.select: unknown session ${sessionId}`);
```

页面**刚加载时**会话列表还在从宿主拉取，所以 `open()` 会抛 `unknown session` → 必须**等待型重试**（现为首次 300ms、之后每 400ms、最多 25 次）。

---

## 四、诊断经验（下次遇到"点了没反应"可以直接复用）

1. **日志在这台机器上不可靠**：Electron 主进程里给文件 `appendFileSync` 静默失败（连顶层哨兵都写不出来）。所以排障改为**把状态画在界面上**（曾用一个头部计数 `c1`/`d1`，定位完已删除）——一次点击就能区分"点击没到面板"与"到了但没生效"。
2. **浏览器控制台是关键**：客户端插件的 `console.log` 用户能看到，服务端写的日志看不到。多轮排查都是靠用户贴控制台才定位到（尤其 `ReferenceError: ctx is not defined` 那一行）。
3. **桩测很有用，但桩本身要有断言**：在 Node 里用假 DOM 加载 `sessions-panel.js`，能验证"点 × 后应显示空态""⟲ 后应恢复"这类逻辑。不过我的桩一开始把 `console.log` 也劫持了、`replaceChildren` 实现有 bug，反而误导了几轮 —— 桩要尽量保真，且**先确认桩能复现已知正确行为**。
4. **文件时间 vs 进程启动时间**：这个项目里"改了没生效"绝大多数是没重启（宿主/渲染端都只在启动时加载）。每次排障先对一下这两个时间。
5. **桩的数据形态必须照抄真实数据**：面板位置 bug 被自己的验证脚本掩盖了两轮 —— 脚本里手写的 `AREAS` 桩返回 `{w,h}`，而真实 `AREAS` 是 `{width,height}`，于是 `wa.w === undefined` 这个真 bug 在桩里根本不存在。**桩要尽量保真，最好直接从真实实现里取数据形态**；能直接 eval 真实实现就别复制公式。
6. **NaN 会静默吃掉所有比较**：`NaN >= min`、`NaN < min` 全是 false，所以 `if/else` 会走进"看似兜底"的分支，而 `bad < limit` 这类断言恒为 false（漏报）。凡是可能拿到 NaN 的地方，断言里必须显式 `Number.isFinite()`。

---

## 五、未做 / 待办

- 面板行样式（余额行位置、字号档位、行距）；宠物尺寸/透明度的可视化调节（现在只能手改配置）
- 与上游同步：上游升级时需要重新取 `lib/client.base.js` 并重跑注入（见 README.fork.md「已知限制」）
- 面板标题栏留了一个**几何自检**：只有算出来的边界是 NaN 时才显示 `GEOM BAD …`，健康时留空。
  渲染端没有任何日志通道（主进程写文件在这台机器上静默失败），这个自检就是它的替代品 ——
  下次几何出问题能一眼看出是哪几个量坏了，不用再来一轮"截图猜原因"。
