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

> **恢复（⟲）的语义改过一次**：最初是"一次全恢复"（清空整个关闭名单）。用户反馈后改成
> **一次恢复最近关掉的一条（后进先出）**。
>
> 理由：行不会自己消失（终态在 /sessions 里保留 24h），所以点 × 一定是主动行为 ——
> ⟲ 的存在理由只剩"误关要能反悔"，而这只需要最近那一条。一次全恢复会把你之前每次
> "我确实不想看这条"的决定一起推翻：只想救回刚误关的那条，却得把其余几条重新关一遍。
>
> 配套的两处细节：
> - **空闲时置灰**：逐条恢复后"还剩几条"成为关键信息，按钮不置灰的话点到底会变成
>   "点了没反应"，用户只会以为坏了（所以 `syncRestoreButton()` 必须放在 render 的
>   "签名没变就提前 return" **之前** —— 会话静默结束时可见行没变、但可恢复数变了）；
> - **不可恢复的记录要排除**：会话结束后会从 /sessions 消失，那条关闭记录已无从恢复，
>   `restorableDismissals()` 只算"当前确实在列表里、且确实被过滤掉了"的，否则按钮会亮着却点不动。
>
> 回归测试：`scripts/test-restore-lifo.mjs`（`npm run test:all`），从真实实现抽出方法运行，
> 已做变异测试（退回"一次全恢复"必须变红）。


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

---

## 桌面版（DSH Desktop）支持

### 背景：桌面版用的是**另一个 profile**

DSH 桌面应用（`DeepSeek Harness.app`）不读 `~/.dsh/profiles/web`，而是自己管理
`~/.dsh/profiles/desktop`（见 `app.asar` 里的 `resolveDesktopPaths()`）。它的 profile 模板只含
`@deepseek-ai/dsh-base` + `@deepseek-ai/dsh-web-app`，所以**默认没有桌宠**；而且外部 CLI
不允许改它（`dsh plugin --profile desktop` 会被拒绝：*managed exclusively by the Electron application*）。

想在桌面版里用桌宠，得用 App 自带的运行时手工装进那个 profile：

```sh
R="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies"
cd ~/.dsh/profiles/desktop
"$R/node/bin/node" "$R/pnpm/bin/pnpm.cjs" add "file:/path/to/dsh-pet"
# 再把 "dsh-pet" 追加到 package.json 的 dsh.profile.bundles
```

### 坑：未签名原生库 vs 强化运行时

装完后桌面版**仍然没有宠物**，原因是宿主 bundle 顶层静态 `import` 了
`@electron/get` 与 `@electron-internal/extract-zip`，而后者带一个**未签名**的原生库
（`index.darwin-universal.node`，`flags=adhoc,linker-signed`）。DSH 桌面版自带的 node 签名启用了
macOS **强化运行时**（`flags=0x10000(runtime)`），会拒绝 dlopen 未签名库：

```
Cannot find native binding. npm has a bug related to optional dependencies…
  cause: dlopen(...index.darwin-universal.node): tried: … (code signature / library validation)
```

系统 node（自己装的，无强化运行时）没有这个限制 —— 所以**这个问题只在桌面版暴露**，
web 版一直正常，很容易误判成"插件没装好"。

**修法**：这两个模块只服务于「本机没有 Electron 时下载 Electron」这条冷路径
（`ensureElectronDownload()` 开头就是 `if (existsSync(exe)) return exe;`），
因此改成**按需动态 import**，顶层不再碰它们：

```js
let electronGetModule; let extractZipModule;
async function loadElectronDownloaders() {
  if (!electronGetModule) electronGetModule = await import("@electron/get");
  if (!extractZipModule) extractZipModule = await import("@electron-internal/extract-zip");
  const extract = extractZipModule.default ?? extractZipModule.extract;
  return { downloadArtifact: electronGetModule.downloadArtifact, extract };
}
```

改完后用桌面版内置 node 加载两个 profile 的 dsh-pet 都成功（`lib/index.js` 顶层不再触发原生库加载）。

### 坑 2：`settingsScope` 在桌面版不存在（版本差异）

装完之后桌面版报：

```
web boot: 1 entry did not activate
dsh-pet: pending (waiting for service: settingsScope)
```

原因不是装错，而是**桌面版那套插件与 npm 上的版本不同代**：

| | 提供的服务 |
|---|---|
| 桌面 App 内置 `dsh-client-ui-settings` **0.1.7-rc.2** | `settingsSchema`, `configForms`（**没有** `settingsScope`） |
| npm 安装的（web profile 用） | `settingsSchema`, `settingsScope` |

而本仓库的面板设置卡片原本把 `settingsScope` 写进了 `inject`。Cordis 的 `inject` **只支持必需依赖**
（对象形式是「服务名 → 拦截配置」，没有可选列表），于是一个**可选功能**把整个宠物拖成 pending。

**修法**：`inject` 数组里移除 `settingsScope`，卡片改为运行时探测：

```js
var __dshScope = null;
try { __dshScope = ctx.settingsScope; } catch (e) { __dshScope = null; }
if (!__dshScope) throw new Error('settingsScope 不可用，跳过设置卡片');
```

代价：桌面版里**设置页不会出现「会话面板」卡片**（那套版本没有该服务），
面板开关仍需手改 `~/.dsh/dsh-pet/main-config.json`。宠物本体与面板功能不受影响。

> 注入脚本 `scripts/inject-deeplink.py` 的自检也同步更新：一旦 `"settingsScope",` 重新出现在
> `inject` 数组里就直接报错，避免以后又踩回去。

### 坑 3：`ELECTRON_RUN_AS_NODE` 让 helper 退化成纯 Node（桌面版桌宠窗口不出现）

**症状**：桌面版里"窗口内的宠物正常显示，但桌面上那个独立宠物窗口完全不出现"。

**根因**：DSH 桌面版把内置运行时当 Node 用，因此**给它自己注入了 `ELECTRON_RUN_AS_NODE=1`**，
而这个变量会随环境继承到**整棵子进程树**。helper 的 spawn 是 `env: {...process.env, ...}`，
于是继承了它 —— Electron 退化成纯 Node，不提供 `electron` 模块，helper 启动即崩：

```
Error: Cannot find module 'electron'
  Require stack:
  - .../dsh-pet/runtime/electron-helper/main.js:31   ← require('electron')
```

宿主只看到"helper 启动失败 → 重启"，桌面上因此永远没有宠物窗口。
`dsh web`（CLI）不受影响，因为那边环境里本来就没有这个变量 —— 又是个只在桌面版暴露的问题。

**修法**：spawn 前剔除该变量（`helperEnv()`），并留注释说明为什么不能只在桌面分支处理：

```js
function helperEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
```

验证：在 `ELECTRON_RUN_AS_NODE=1` 的环境下按同样方式手工拉起 helper，
进程稳定存活并正常拉取 `/dsh-pet-7340/config`（修复前会立刻抛上面那个错误退出）。

> 排查提示：`Electron --version` 如果输出的是 **Node 版本号**（而不是 Electron 版本）且
> `require('electron')` 失败，那就是 `ELECTRON_RUN_AS_NODE` 在作祟，不是 Electron 装坏了。

### 坑 4：`sessions.open` 在新版客户端不存在（桌面版会话跳转失效）

**症状**：桌面版里点面板上的会话行，浏览器打开了但**没切到该会话**。

**根因**：会话"打开/选中"的 API 换代了：

| 版本 | 打开会话的 API |
|---|---|
| npm 上的 0.1.5-rc.1（web profile 用） | `sessions.open(id)` **和** `uiWorkspace.openSession(id)` |
| DSH 桌面版 0.1.7-rc.2 | `sessions` 已改版（只有 `retain`/`using`/`scope`/`search`/`fork`/...，**没有 `open`**）；选中会话由 **`uiWorkspace.openSession(target)`** 承担 |

`uiWorkspace.openSession` 的契约（Inspect 实测）：*"Select a Session and show its Conversation as one UI navigation action."*

**修法**：深链改为**优先 `uiWorkspace.openSession`、回退 `sessions.open`**（顺序反过来则新版直接抛
`sessions.open is not a function`）。两者都不可用时打印明确告警，便于日后 API 再变时定位。
桩测覆盖两条路径：

```
新版(uiWorkspace): ✅ session-xyz   via=uiWorkspace.openSession
旧版(sessions):    ✅ session-xyz   via=sessions.open
```

### 坑 5：桌面版点面板会"跳出到系统浏览器"（已修）

**背景**：DSH 桌面 App 注册的 URL scheme 是 `dsh://`，而它**只处理 `dsh://open`（聚焦主窗口）**，
没有会话级深链（`app.on("open-url")` 里就那一个分支）；命令行也不解析会话参数
（`second-instance` 只做 `focusOwner`）。所以"打开 `?session=<id>`"在桌面版下必然是
**打开系统浏览器**，而不是切到 App 自己的窗口。

**修法**：恢复并加固「面板 → 页面」的轮询通道，让点击留在 App 内：

```
面板点击 ──POST──▶ 宿主 /dsh-pet-7340/open-session   （登记 {id, nonce}）
                        │
   已连在该宿主上的页面 ◀──GET（每秒）── 领取 {sessionId, nonce}
                        │
                  调 uiWorkspace.openSession(id)  ← App 自己的窗口内切换
                        │
                   GET ?ack=<nonce>  ← 告诉宿主已处理，避免重复切
```

三条工程决定（都有理由，别随手改）：

1. **用轮询而不是 WebSocket/SSE**：宿主侧只要一个内存变量 + 一个 GET 端点，没有长连接生命周期要管。
2. **失败不 ack**：`openSession` 抛错时保留待打开状态，下次轮询自动重试（会话列表可能还没就绪）。
3. **深链保留为兜底，由宿主的 `hasPage` 决定走哪条**：宿主在 POST 响应里回
   `hasPage = 最近 5 秒内有页面轮询过`。
   - 有页面（桌面版常态）→ 只走通道，**不打开浏览器**；
   - 没有页面（App 窗口没开 / 纯 CLI）→ 退回深链 `?session=`，把页面打开并直达该会话。

   这样"桌面版留在 App 内"和"CLI 下仍能跳转"两个诉求同时满足。

桩测（覆盖完整握手）：

```
轮询定时器: 1 个
轮询调用: /dsh-pet-7340/open-session , /dsh-pet-7340/open-session?ack=nonce-1
打开会话: ✅ session-abc
已 ack: ✅ nonce-1
```

### 坑 6：切了会话但窗口还在后台（点击"像没反应"）

**症状**：App 在前台时点面板某一行 → 正常切到该会话；但 App **最小化或在后台**时点击，
会话其实也切了，只是**没有把窗口带到前台** —— 观感上就是"点了没反应"。

**根因**：`uiWorkspace.openSession(id)` 只负责"选中会话并展示对话"，**不管窗口是否在前台**。
最小化/后台时用户看不到结果。

**修法**：点击后补一次 `dsh://open`。DSH 桌面 App 注册的 `dsh://` 里**只处理 `dsh://open`**
（`app.on("open-url")` 里唯一分支），其内部正是 `window.restore(); window.show(); window.focus();` ——
恰好就是"恢复最小化 + 聚焦"。

新增 IPC `pet:focus-app`（**没有**放宽既有的 `pet:open-site`，那个只放行 http(s)，
有意避免宠物窗口成为任意 URL 的执行入口）。

时序：**延迟 350ms 再抢焦点** —— 先让页面轮询把会话切过去，否则可能出现"窗口抢到前台时会话
还没切完"，观感上像闪了一下旧会话。

### 便利改动：宠物窗口的开发者工具入口

DSH 桌面 App 的 **F12 / 菜单项只作用于 App 主窗口**（`window.webContents`），宠物窗口是独立
浏览器进程，出问题时没有任何观察通道 —— 这段时间排查点击/余额问题基本靠猜。

在宠物右键菜单加一项「**开发者工具**」（`pet:devtools` → `BrowserWindow.fromWebContents(sender)`），
打开的就是该宠物窗口自己的 DevTools。

### 坑 7：升级 App 到 0.2.x 后整个插件被**静默跳过**（桌宠消失）

**症状**：DSH 桌面版从 0.1.7-rc.2 升到 **0.2.0-rc.1** 后，桌宠窗口不再出现；
但 profile 配置、安装目录、文件内容全部正常。

**根因**：新版 App 的 profile 加载会对每个 bundle 做**兼容性体检**
（`dsh-app-boot` 的 `evaluatePluginCompatibility`）：把插件 `package.json` 里所有
`@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 `peerDependencies` 范围拿去和**运行时版本**比对，
不满足就**跳过该 bundle**，只往 stderr 写一行（App 里根本看不到）：

```
dsh: skipping profile bundle "dsh-pet": { incompatible peers … runtimeVersion: 0.2.0-rc.1 }
```

本插件的 peer 原本是 `^0.1.1-rc.2`，**不满足 0.2.x** —— 于是整个插件（宿主半侧 + 客户端半侧）
被跳过：`/dsh-pet-7340/*` 全部 404、宿主插槽树里查不到 `dsh-pet`、helper 自然也不会被拉起。

**修法**：把 9 个 `@deepseek-ai/dsh*` peer 统一收紧到 **`^0.2.0-rc.1`**。

**为什么是收紧而不是放宽**：check 的语义是"**这个区间是否接受当前运行时版本**"。本仓库的
使用形态是「桌面版为主」，而桌面 App 与 CLI 都会拉最新版（两者版本一致），所以只要声明
当前这一代即可 —— 范围越宽，越容易把"没测过的版本"也宣称成兼容，而跨次版本是真的会断 API
（坑 4 的 `sessions.open()` 被删、坑 2 的 `settingsScope` 消失都是实例）。

**`^0.2.0-rc.1` 的实际接受集**（实测，注意 semver 预发布规则）：

| 运行时版本 | 是否通过 |
|---|---|
| `0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.0` / `0.2.1` | ✅ |
| `0.3.0-rc.1` / `0.3.0` | ❌ ← 大版本自动拦下，提醒重新测 |
| `0.2.5-rc.1` | ❌（semver 预发布边界，可接受） |

> 曾一度写成 `>=0.1.1-rc.2 <0.3.0-0`（为兼容当时的 0.1.5-rc.3 CLI）。确认不再用旧 CLI 后
> 收紧为 `^0.2.0-rc.1`。两者对 0.2.x / 0.3.x 的判定**完全一致**，差别只在下界是否还接 0.1.x。

验证（用 App 自己的 `evaluatePluginCompatibility`）：

```
0.2.0-rc.1: ✅ 通过    0.1.7-rc.2: ❌ 被拒（符合预期）  0.1.5-rc.3: ❌ 被拒（符合预期）
```

> 排查提示：`dsh-pet` 在某个新版本 DSH 上"凭空消失"且没有任何报错时，**先查 peer 范围**。
> 也可以把 `dsh-desktop-host` 的 stderr 接出来看 `skipping profile bundle` 那行。

---

## 升级 DSH 时的检查清单

每轮 DSH 大版本更新后，**dsh-pet 最可能以"静默消失"的方式坏掉**（没有报错、App 内部看不到）。
按下面顺序查，每一步都能用命令或 read-only Inspect 验证，不需要猜：

### 1. 先确认插件到底加载了没有

```sh
# 插件路由还在吗？404 = 宿主半侧根本没加载
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:<port>/dsh-pet-7340/config

# helper 起来了吗？
pgrep -f "electron-helper/main" | wc -l
```

也可以查宿主的 loader 目录（read-only Inspect）：`listConfigs({ name: "dsh-pet" })`，
返回 `entries: []` 就说明 bundle 层压根没被应用。

### 2. 最常见的原因：`peerDependencies` 版本检查（坑 7）

DSH 0.2.0 起，profile 加载会对每个 bundle 做兼容性体检：
插件的 `@deepseek-ai/dsh*` peer 范围必须**接受当前运行时版本**，否则跳过整个 bundle
（只写 stderr，App 里不可见）。

**所以每次 DSH 大版本升级的第一件事：把 9 个 `@deepseek-ai/dsh*` peer 收到当前代**
（例如 `^0.2.0-rc.1`）。验证可以直接用 App 自带的函数：

```js
import { evaluatePluginCompatibility } from '<app>/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';
evaluatePluginCompatibility(manifest, {}, '0.2.0-rc.1')   // undefined = 通过
```

### 3. 再看那几个"只在桌面版暴露"的差异点

| 差异 | 检查方式 |
|---|---|
| 宿主 node 启用**强化运行时** → 未签名原生库被拒 | 顶层不得静态 import `@electron/get` / `extract-zip`（坑 1） |
| 那代 `ui-settings` 可能**没有 `settingsScope`** | 不得把它写进 `inject`（坑 2） |
| 宿主注入 **`ELECTRON_RUN_AS_NODE=1`** | spawn helper 必须用 `helperEnv()` 剔除（坑 3） |
| 会话打开 API 可能换代 | `uiWorkspace.openSession` 优先、`sessions.open` 回退（坑 4） |
| App 的 `dsh://` 只有 `dsh://open` | 会话跳转走面板轮询通道，不依赖深链（坑 5） |

### 4. 最后确认版本相关的东西

桌面 profile 是 `pnpm add file:` 装的，**改依赖（package.json）后要重新安装**；
只改代码是硬链接、直接生效（但用编辑工具改写会断链，需要 `cp`）。
profile 由 App 独占管理，外部 `dsh plugin --profile desktop` 会被拒绝。

### 坑 8：桌面版点面板偶发"打开一个报认证错误的 URL"

**症状**：多数时候点击能在 App 内切会话，但**有时**会打开系统浏览器，页面显示：

```
dsh web authentication required; reopen the URL printed by dsh web.
```

**根因（两个叠加）**：

1. **判定"有没有页面"会误报**。面板点击后由页面侧轮询领取，而宿主用
   `hasPage = 最近 5 秒内有页面轮询过` 来判断"页面在不在"。**窗口隐藏/最小化时浏览器渲染进程
   会被节流/暂停**，轮询停了 → `hasPage` 变 false → 面板走"兜底打开页面"分支 → 开浏览器。
2. **兜底用的是裸地址**。桌面版对页面有 **token 闸门**，`http://127.0.0.1:<port>/?session=…`
   必然被拒 —— 于是浏览器里看到那条认证错误。带 token 的地址只有宿主知道
   （`ctx.connection.authenticatedUrl()`）。

**修法（两条一起）**：

- 宿主随 `/config` 下发两个字段：
  * `appUrl` —— 经 `ctx.connection.authenticatedUrl()` 处理的**已认证**页面地址；
  * `isDesktopApp` —— 判据是 `NODE_CHANNEL_FD`（父进程用 `stdio: [...,'ipc']` 拉起子进程时
    Node/Electron 注入；DSH 桌面 App 正是这样拉起 `dsh-desktop-host` 的，CLI 没有）。
- 面板据此分支：
  * **桌面 App**：无页面时**只聚焦窗口**（`dsh://open`），**绝不开浏览器** —— 待打开的会话留在
    宿主里，窗口回到前台后渲染进程不再被节流，轮询恢复即自动领取切换；
  * **CLI**：无页面时用**已认证地址**打开并直达该会话。
- 顺带修掉菜单「打开网站」同样拼裸 `ORIGIN` 的问题（桌面版下点它也会撞 token 闸门）。

**教训**：任何"把用户送到 DSH 页面"的地方都必须用宿主下发的已认证地址，
**不要在渲染端自己拼 origin** —— 桌面版的 token 闸门会让裸地址必然失败。

### 坑 9：`NODE_CHANNEL_FD` 判桌面版不可靠；`connection` 没进 inject 导致 appUrl 没 token

**发现时机**：桌面版升到 **0.2.1-rc.2** 后复核坑 8 的两个字段，发现：

```
/config → appUrl: http://127.0.0.1:60338/     ← 没有 token
          isDesktopApp: false                  ← 但明明在桌面版里
```

**两个独立原因**（都是本仓库自己的实现问题，不是 DSH 新版造成的）：

1. **`NODE_CHANNEL_FD` 在运行期读不到**。`ps eww` 能看到它（那是 exec 时的初始环境），
   但 Electron/Node 会在启动过程中把它从 `process.env` 删掉。
   **决定性证据**：helper 是用宿主 `process.env` 派生的（`helperEnv()` 只删 `ELECTRON_RUN_AS_NODE`），
   而 helper 的环境里**没有** `NODE_CHANNEL_FD` —— 说明宿主的 `process.env` 里已经没有它了。
   → 改用 **`process.versions.electron`**：桌面 App 的宿主跑在 Electron 的 Node 模式下，有值；
     CLI（普通 node）没有。实测：普通 node → `undefined`，Electron 模式 → `43.3.0`。
     也**不能**用 `ELECTRON_RUN_AS_NODE` 兜底：某些 shell 会预置它，会把 CLI 误判成桌面版。

2. **`connection` 不在宿主 `inject` 数组里**，`ctx.connection` 取不到 →
   `authenticatedUrl()` 调用被 try/catch 吞掉 → 退化成裸地址。
   → 把 `"connection"` 加进 `inject`，`appUrl` 才会带上 `?token=…`。

**验证**（桩测真实路由处理函数）：

```
桌面版（Electron 模式 + authenticatedUrl 加 token）:
  appUrl: http://127.0.0.1:60338/?token=TESTTOKEN   含 token ✅   isDesktopApp: true  ✅
CLI（普通 node，无 token）:
  appUrl: http://127.0.0.1:60338/                   裸地址 ✅     isDesktopApp: false ✅
```

**教训**：
- 判断"跑在哪个壳里"要用**运行时事实**（`process.versions.electron`），
  不要用 `ps` 能看到的环境变量 —— 它反映的是 exec 时的初始环境，可能已被运行时修改。
- 访问 Cordis 服务前先确认它在 `inject` 里；否则直接用属性访问会失败，而 `?.` + `try/catch`
  会让失败**完全静默**（这次的症状就是"看起来拿到了 URL，其实没 token"）。

### 坑 10：宠物在第二屏左侧时，头顶面板在**两个位置之间持续闪烁**

**症状**：宠物跑到第二屏左侧，头顶会话面板在两个位置之间反复闪（一个偏左、一个居中）。

**根因（位置计算里有两个问题叠加）**：

1. **参考屏选择会二值翻转**。面板的边界夹取以"宠物所在那块屏"为基准，选屏用的是
   `resolveRect` → **最近距离**。当宠物落在两块屏之间的**空洞**里（多屏外接矩形中不被任何屏
   覆盖的区域），"最近屏"会随着 1px 的移动在相邻两块屏之间来回翻。
   **实测数据**（用真实双屏几何 0,0,1512x982 + 1512,-458,2560x1440 计算）：
   在空洞边缘把宠物挪 1px，面板左缘从 **44px 直接跳到 231px（Δ=187px）** —— 这就是看到的"闪"。
   第二屏左缘正好是空洞边界，所以这个问题只在那个位置暴露。

2. **坐标系混用**。`winScreenL = pos.x + VIEW.x - margin.l` 得到的是**屏幕坐标**，而 `AREAS`
   是**外接矩形原点相对坐标**（= 屏幕坐标 − VIEW 原点）。单屏或外接矩形原点为 0 时恰好等价，
   多屏且原点非 0（左侧还有一块屏）时会算错夹取边界。

**修法**：

- **空间粘滞**：点位不在任何屏内时，先看"上一次选中的屏"——只要宠物中心离它不超过一个身位
  （`max(40, size)`），就继续用它，不再重新选最近的。
- **时间迟滞**：目标左缘相对上次已应用值跳变 > 24px 时，只有宠物**累计移动**超过 12px 才接受；
  否则保持不动。真正走路跨屏时位移会累积，很快越过阈值，不会卡住。
- **几何变化时重置**迟滞与参考屏（插拔屏/改分辨率后宠物没动，但正确位置变了，不能被迟滞挡住）。
- **坐标系统一**：窗口左/上缘直接用 `pos − margin`（与 `AREAS` 同坐标系），不再加 `VIEW.x/y`。

**验证**（同一套真实几何 + 与实现一致的计算）：

```
① 空洞边缘 ±1px 抖动：最大跳变 1px  ✅（旧逻辑 187px）
② 接缝上合法翻屏 ±1px：位置恒定     ✅（迟滞生效）
③ 持续行走 40px：跟随到新位置       ✅（未卡死）
④ 常规位置回归：第二屏中部 / 主屏中部 left=90（居中）✅
```

> 教训：**用"最近距离"在相邻区域间做选择时，必须加粘滞/迟滞**。两块相邻区域只在边界差一点点，
> 而下游计算可能把这点差别放大成上百像素的位移 —— 宠物只要在边界上轻微移动就会持续闪烁。

### 排障便利：右键菜单「复制定位信息」

DSH 客户端里用户没有方便的控制台入口（主窗口的 F12 只作用于 App 主窗口，宠物窗口是独立进程）。
为了在不要求用户开 DevTools 的前提下拿到定位数据，宠物右键菜单加了一项
**「复制定位信息」**：把下面这份 JSON 写进剪贴板，粘贴给开发者即可。

```json
{ pos, center, size, areaIndex, areas, view, scale, geo, panelLeft, lastDragRaw }
```

- `areaIndex` = -1 表示宠物中心落在**空洞**里（不属于任何屏幕可视区）
- `areas` 是助手认为的逐屏工作区（视口相对）；`geo` 是主进程下发的原始几何（物理像素）
- `panelLeft` 是面板当前实际左缘，可直接对照"是否居中"

链路：`sprite.js` 菜单 → `petBridge.copyText`（preload）→ 主进程 `pet:copy-text` →
`clipboard.writeText`。另外 `applyDeskGeometry` 会把原始几何留档到 `window.__dshPetGeo`。

### 坑 11：拖拽到屏缝时"拖不过去、松手弹走、面板不居中"

**症状**（用户实测快照）：按下时宠物 `x=552`，指针拖了 **+954 DIP**，应落到 `x≈1029`；
实际停在 `x=709`，且面板左缘 `141`（居中应为 90）。

**两个独立原因**：

1. **拖拽中途被翻成点击穿透，输入链断了**。
   `sprite.js` 的 `mouseleave` 无条件 `setInteractive(false)` —— 而拖拽时宠物窗口跟着光标逐帧移动，
   光标很容易短暂离开窗口，一翻穿透就再也收不到 `pointermove/pointerup`：
   宠物定格在中途、`pointercancel` 按最后一段轨迹速度触发 `startThrow` → 被物理夹到区域边界。
   **证据**：位移只完成了 954 中的 314，落点正好是 `区域1.x − sideAllow ≈ 709`。
   → `mouseleave` 加 `inputBusy()` 守卫（拖拽/菜单/弹窗在用输入时绝不翻穿透）；
     主进程 `pet:set-interactive` 也加同样守卫（busy 期间忽略"翻穿透"请求），双保险。

2. **面板夹取用了"宠物中心那块屏"，而不是"与窗口相交的所有屏"**。
   宠物骑在屏缝上时，居中位置会跨到相邻屏 —— 而两块屏**都可见**，不该被夹。
   → 允许范围改为**与窗口相交的所有屏的并集外包**。

   **用真实快照数字验算**（`pos.x=709`、窗口 720×489、屏幕 `0..756` 与 `756..2036`）：

   ```
   旧逻辑 left = 141  ← 与用户实测 panelLeft 完全一致（复现）
   新逻辑 left = 90   ← 正好居中
   ```

> 教训：窗口跟随指针的拖拽，**不能因为光标离开窗口就翻回穿透**——这类"自移动窗口"的交互里，
> 离开窗口是常态而不是用户离开。判定要用"我是否正在使用输入"（inputBusy），
> 而不是"光标现在在不在窗口里"。

### 坑 12：屏缝附近有一段"放置禁区"（怎么都拖不进去）

**症状**：拖到第二屏左侧时，宠物能走一段，但有一段区域**放不进去**，松手会被吸到边界一端。

**根因**：落地/抛掷按"身体中心所在那块屏"的边界夹取，左右各留
`sideAllow = (HIT_BOX.x0/640) × size`（size=180 时 ≈ **56px**）。于是屏缝两侧各有一个内缩边界：

```
第二屏左界：756 − 56 ≈ 700
主  屏右界：756 − 180 + 56 ≈ 632
        → 632..700 成了谁都放不了的禁区
```

而这段位置在视觉上完全合法（身体横跨两块都可见的屏）。

**修法**：松手时若**身体同时压住两块屏**（`AREAS` 里与身体横向相交的屏 ≥ 2），直接落下、
不交给抛掷物理夹取；其它位置保留原有抛掷手感。漫游边界不变（仍按工作区，避免走到菜单栏/程序坞上）。

**验证**（size=180、屏缝 756）：

| 想放在 | 旧 | 新 |
|---|---|---|
| 632 | 632 ✅ | 632 ✅ |
| 660 | 632 ❌ 被夹走 | **660 ✅** |
| 680 | 700 ❌ 被夹走 | **680 ✅** |
| 700 | 700 ✅ | 700 ✅ |

> **更正**：后续用物理函数直接探针发现，"禁区"并不会被硬夹（缝对面有屏即视为可穿越）；
> 该特例已删除，改由「坑 13」的统一规则处理。

### 坑 13：用一条统一规则替换"逐屏边界 + 特例"

**背景**：坑 12 的"跨屏就跳过抛掷"只是补丁。实际用物理函数做探针后发现更准确的事实：

- 零速自由落下时，屏缝两侧的 x 位置**本来就能停住**（`throwStepRegion` 里有两处
  `indexAtPoint(space.panels, …)` 判断：缝对面有屏就当可穿越，不夹）；
- 坑 12 里说的 `632..700` 缺口只在**真正的外墙**上才会触发；用户那次停在 709
  主因是**输入链断掉**（坑 11），不是边界。

所以改为一条可解释的统一规则（用户提出、已实现）：

| 规则 | 实现 |
|---|---|
| **宠物中心必须落在某块屏上**（保证可见） | 每步积分后，中心不在任何 `panels` 内就夹回最近的一块 |
| **x 用所有屏的并集外包**（缝上不再有内缩缺口） | `throwSpace` 的 `minX/maxX` 改用 `unionRect(areas)` ± `sideAllow` |
| **y 仍按中心所在那块屏**（高度对不齐时按该屏边缘） | `throwBoundsIn(area)` 的 `minY/maxY` 保持不变 |
| **外边缘保留 `sideAllow`**（画布透明留白可挂出，身体才好贴边） | 并集外包左右各扩 `sideAllow` |
| 不要求同时在两块屏上显示 | 画布允许跨边界，只约束中心 |

同时删除了坑 12 的"跨屏跳过抛掷"特例 —— 物理已经统一，特例只会让手感不一致。

**探针验证**（真实双屏几何、直接调用 `throwSpace`/`throwStepRegion`）：

```
水平 632/660/680/700 自由落下 → 全部保持 ✅（缺口消失）
竖直 (680,100)/(680,600)/(600,100) 落下 → 中心均落在某块屏 ✅（可见性兜底生效）
带横向速度 vx=300 从 560 甩出 → 跨到第二屏落定 ✅
```

> 影响面：`shared-core.js` 只被桌面 helper 使用；浏览器 overlay 的 `lib/client.js`
> 内联了自己的一份（`grep unionRect lib/client.js` = 0），不受影响。

### 坑 14：普通拖拽松手被判定成"抛掷"→ 宠物被甩走

**症状**：拖到目标位置松手，宠物却飞出去很远（"还是会弹走"）。

**根因**：`estimateReleaseVelocity` 的轻放阈值 `DEAD_ZONE_SPEED = 500 px/s` 太低。
普通拖拽松手的余速常在 800–1500 px/s，直接被判成甩掷；物理探针里 `vx=300` 就能把宠物
从 560 带到 1613（约 1000px）。

**修法**：
- 阈值抬到 **1200 px/s**：≤1200 视为"轻放"（原地落下），≥1500 才算甩掷；保留甩着玩的手感；
- 支持配置覆盖：`main.physics.releaseSpeed`（例如设 2000 让自己几乎不会甩出去）。

**验证**（纯函数 `estimateReleaseVelocity`）：

```
300 / 600 / 900 / 1200 px/s → 轻放（原地）
1500 / 2400 px/s           → 抛掷（vx=1227 / 1752）
releaseSpeed=2000 时 1500  → 轻放 ✅
```

### 坑 15：跨屏拖动时面板可能被挤出窗口画布

**症状**：从副屏拖到主屏时，头顶面板有时跑到画布外（看不见或被裁）。

**原因**：面板 `left` 完全依赖边界计算（并集外包 + 相交屏判定）。一旦窗口几何与屏幕几何的
换算在某处有偏差，算出的 `left` 可能超出 `[0, winW − 面板宽]`，溢出部分直接被窗口裁掉。

**修法**：加一条**与几何正确性无关的硬夹**——`left` 永远夹在 `[0, winW − PANEL_NATURAL_W]`。
这是兜底，不替代边界计算，但保证"面板绝不会跑到画布外"。

> 快照同时补了 `win{w,h}` 与 `lastThrow{x,y,vx,vy}`：下次若仍异常，可一眼区分
> "是抛掷带走的" 还是 "被边界夹走的"。

### 坑 16：拖拽只走指针位移的约 1/3 就定格（pointermove 依赖命中区）

**症状**：拖拽时宠物跟一段就停，实际位移只有指针位移的约 1/3；两次快照都是同一特征：
`petX=552`、指针 +894 DIP（应到 `x≈999`）、实际停在 `680`。

**根因**：拖拽的 `pointermove` 监听绑在**宠物命中区**（`this.hit`，一个小矩形）上。
拖拽时窗口由我们自己的 `setBounds` 逐帧移动，指针很容易跑出命中区 ——
此时即使有 `setPointerCapture`，一旦窗口/渲染端状态有变化（如穿透翻转、跨屏），
事件也会中断，拖拽就定格在最后一次采样。

**修法**：拖拽期间由**主进程按帧喂系统光标位置**（`screen.getCursorScreenPoint()`），
与窗口/命中区无关：

- preload 新增 `setDragActive(bool)` / `onCursor(cb)`；
- main 在 `pet:drag-active` 期间以 ~16ms 间隔向该窗口发 `pet:cursor {x,y}`；
- sprite 的 `onCursorSample()` 复用同一套 press 基准与弹簧跟随；
  **只在 pointer 事件停滞 >60ms 时才接管**（避免两路数据源互相拉扯），
  并在接管瞬间做一次**常数偏差校准**（吸收光标与 pointer 的单位/原点差异）；
- 兜底接管期间不喂速度轨迹 → `estimateReleaseVelocity` 因轨迹过期返回 null → 松手原地放下，
  不会被误判成甩掷。

**另**：渲染端脚本走 `file://`，出现过"文件已更新但页面仍用旧脚本"（快照缺新字段、
行为像上一版）。helper 启动时 `session.defaultSession.clearCache()` 一次；快照新增 `rev` 字段，
可直接确认运行版本（当前 `r5`）。

### 坑 17：宠物停住后，面板卡在旧位置（"不在边缘却不居中"）

**症状**：宠物明明在屏幕中间，头顶面板却偏在一边（截图里贴左）。

**根因**：坑 10 引入的"大幅跳变需稳定 150ms 才应用"只写了 `return`，**没有定时器兜底**：
该判定依赖"下一次 `reposition` 调用"来应用新值，而 `reposition` 由 `sendBounds` 驱动 ——
**宠物停下来以后就不再有调用**，挂起的目标永远不会生效，面板就停在旧 `left` 上。
（旧值往往来自上一次移动途中，于是看起来"偏左且怎么都不回正"。）

**修法**：
- 新增 `applyPanelLeft()` 作为唯一出口（赋值 + 记录 + 清挂起/定时器）；
- 大幅跳变挂起时同时设一个 `PANEL_SETTLE_MS + 30ms` 的定时器：到点若目标未被更新就应用；
- 状态在构造函数里显式初始化（`_appliedLeft/_pendingLeft/_pendingSince/_settleTimer` 等），
  几何变化时连定时器一起清。

**验证方式**：把宠物拖到主屏中部松手，面板应在 ~150ms 内回到居中（`left ≈ 90`），
不会一直贴着旧位置。

### 坑 18：诊断字段缺失的真相 + 面板夹取改为"整个桌面并集"

**① 为什么快照一直缺 `rev`/`win`/`bounds`**

不是缓存，也不是没重启 —— 是**我把字段加到了另一个函数**：
`rev`/`win`/`bounds` 写在**面板**的 `__dshPetDebug.snapshot()` 里，
而右键菜单「复制定位信息」用的是 **sprite 自己手写的一份 JSON**，从不调用那个快照。
→ 已改为以面板快照为底（`...base`），再补 `geo`/`lastDragRaw`/`lastThrow`。

**验证**：起一个独立 helper（同一份部署代码 + 远程调试）执行快照，得到
`rev='r5'`、`win={w:360,h:244}`，字段齐全 —— 证明部署代码与加载路径都是对的。

**② 面板"偏左 / 居中 / 偏右"的锯齿**

夹取范围原本取"**与窗口相交的屏**"。窗口宽 360，宠物靠近主屏右侧时窗口开始压到第二屏，
相交集合一旦变化，`boundR` 就从主屏右边缘跳到第二屏右边缘 → 夹取结果跳一次 → 锯齿。
→ 改为**整个桌面所有屏的并集外包**（连续量），面板在桌面内部**恒定居中**，
只有贴到桌面最外侧才收边。

**扫描验证**（真实几何，宠物 x 0→1950 每 50 取样）：

```
left=90（居中）之外：仅 pos=0（94，窗口已出桌面左缘）、pos≥1900（42/0，桌面最右侧）
其余全部 90
```

### 坑 19：拖拽"滑开"与面板越界（两处回归）

**① 拖拽时主体跟手偏移、跨屏时滑得更远**

光标兜底驱动（坑 16）里有个错误实现：接管时用"上一次指针位置"当参考算偏差
（`bias = 光标 − 上次指针`），而把**移动量**也算进了偏差 —— 于是 `px = 光标 − bias`
几乎等于按下位置，宠物被固定在旧位置，观感就是"点起来会滑开"，走得越远偏得越多。
系统光标与 `screenX/Y` 本来就是同一单位（DIP），**偏差应为 0**。
另：按下那一瞬间不算"停滞"，需重置 `_lastPtrMoveAt`，否则第一帧采样就接管。

**② "靠边不越界"失效**

上一轮把面板夹取改成了"整个桌面并集"，宠物贴到本屏边缘时面板不再被收回本屏，
会跨到相邻屏或空洞上。已改回 **宠物中心所在那块屏** 的工作区作为允许范围；
跨屏切换仍由"中心在哪块屏"决定，配合坑 17 的稳定定时器不会闪。

**扫描验证**（真实几何，窗口 360 / 面板 180）：

```
pos= 50 → left= 90  屏幕左缘= 50  ✅ 本屏内
pos=300 → left= 90  屏幕左缘=300  ✅
pos=520 → left= 90  屏幕左缘=520  ✅
pos=600 → left= 62  屏幕左缘=572  ✅ 被收回到本屏右缘
pos=700 → left=150  屏幕左缘=760  ✅ 切到第二屏后收回到其左缘
pos=900 → left= 90  屏幕左缘=900  ✅ 居中
```

### 坑 20：屏缝处面板"慢闪"（参考屏逐帧翻转）

**症状**：从主屏移出去不闪了，但宠物在**副屏左侧（屏缝）**时面板仍会闪，约 3Hz。

**根因**：面板的参考屏由"宠物中心落在哪块屏"决定。中心停在缝上（或附近轻微抖动）时，
参考屏逐帧翻转；而两块屏的夹取基准相差约 **170px**。
配合坑 17 的"稳定 150ms"判定，就表现为**慢速来回闪**（约每 150ms 换一次），而不是高频抖。

**修法**：给"换屏"加**空间迟滞** —— 要切换到另一块屏，中心必须已经进入该屏
`min(32, max(8, size×0.15))` 之内；在死区内保持原来的参考屏。

**验证**（真实几何）：

```
缝上 ±20px 抖动 → 参考屏切换 0 次 ✅
从主屏走向副屏 → 在 756+32=788 附近一次性切换（785→主屏，790→副屏）✅
```

> 配合关系：空间迟滞（防逐帧翻转）+ 时间稳定（防大幅跳变闪烁）+ 定时器兜底（防停住不落位），
> 三者缺一都会以不同形态复现"闪"。

### 坑 21：屏缝上方空洞区"拖进去被闪出来"（其实是宠物被物理夹回）

**症状**：副屏左上有一片"快速变了就闪"的区域 —— 从上往下拖会被闪回上方，
从右侧往左拖会被闪到右侧。

**根因**：坑 13 的物理兜底要求"宠物**中心**必须落在某块屏上"。而屏缝上方那片区域
（主屏工作区尚未开始、副屏在右侧）里，中心可能落在空洞，但**身体有一半在副屏上可见**。
中心不在屏内 → 每帧被夹回最近的屏 → 观感就是"被闪出去"。

**修法**：把判据从"中心在屏内"放宽为"**身体与任一块面板有重叠**"（部分可见即可），
只有身体**完全**落在空洞里才夹回最近屏。符合用户的原则：只要在某块屏内显示即可，
不要求同时在两边显示。

**验证**（真实几何 + 真实物理函数）：

```
拖到 (740,150) → 落定 (740,606)   水平保持 ✅（只受重力落地）
拖到 (700,150) → 落定 (700,606)   ✅
拖到 (600,120) → 落定 (600,582)   ✅
```

**另**：面板位置轨迹（`panelTrace`，最近 40 条，含 left/top/参考屏）已接入「复制定位信息」，
以后再出现位置异常，一次复制就能看出跳变的两个值。

### 坑 22：参考屏迟滞过大 / 物理侧缺迟滞

**① 从副屏回主屏时面板要先"走很远"才正常**

坑 20 的参考屏迟滞用了最多 32px。宠物中心已经进主屏，参考屏还赖在副屏，
面板于是被夹在**副屏左缘**（看起来贴在宠物右侧），必须再往左 32px 才切回。
→ 迟滞只用于防抖，改小到 **8px**。

**② 副屏上方"不停闪烁弹回"**

物理侧 `screenOfBox` 没有迟滞：在屏缝上方的空洞/边界带里，"最近屏"会随 1px 移动在两块屏
之间翻转；而两块屏的 `minY` 差 235.5px —— 翻一次就把宠物上下弹一次。
→ `screenOfBox` 加同样的迟滞（切换需进入新屏 `min(24, max(6, size×0.1))`；
空洞里粘住上一次的屏，容差一个身位）。状态存在 `space._screen`。

**验证**：

```
空洞带 (740,100) ±6 抖动 → 屏归属稳定（切换 0 次）✅
副屏中部投放 → 正常落地 ✅
```

### 坑 23（根因）：macOS 会挪走"骑在混合 DPI 屏缝上"的窗口

**这是长期闪烁的真正根因，已用裸 Electron 最小复现证明（与 dsh-pet 代码无关）。**

复现（`/tmp/move-test`，透明无边框窗口，跨缝遍历）：

```
屏：主屏 0..1512 点 @2x，副屏 1512..4072 点 @1x
请求 x=1200（窗口 62% 在副屏）→ 实际 x=3760   ← 被系统挪走 2560 点
请求 x=900 （85% 在主屏）    → 不动
请求 x=1500（完全在副屏）    → 不动
```

**规律**：窗口骑缝且**大部分落在 1x 那块屏**时，系统会把它放到别处。
我们每帧再设回来 → 宠物在"拖动位置"与"被挪后的位置"之间闪。

这解释了所有历史现象：

- 为什么只在**副屏左侧**闪：窗口居中在宠物上，宠物到副屏左侧时窗口大部分在副屏 → 触发；在主屏侧不触发
- 为什么 `panelTrace` 平滑、逻辑位置正确：**我们的坐标一直是对的，是窗口被系统搬走了**
- 为什么 `boundsMismatch` 出现 1400/2560 级偏差：正是这个搬移

> 诊断误报更正：`posJumps` 一直是 `null` 其实是**探针没接上**
>（`notePosJump` 的调用点当时没插进去）。本次已修好调用点。

**修复（方案 A）**：

1. **窗口宽 = 宠物画布宽**：左右余量 90 → 0（窗口 360×244 → 180×244 CSS）
2. **归属屏夹取**：`sendBounds` 里把宠物左上角夹进归属屏 `[屏左, 屏右 − size]`，
   窗口因此**永不骑缝**；归属屏 = 拖拽时锁定的那块（松手解除），其余时刻按中心自动
3. 松手时若指针落点中心**已进入另一块屏**才转移归属（否则贴在边缘 = "弹回本屏"观感）
4. 面板 `left` 恒为 0（窗口宽 = 面板宽）；菜单列宽改为 `min(240px, calc(100vw - 8px))`
5. 命中区公式同步（`pointer-target.js`：左右余量 0 后 `stageW = 窗口宽`，顶部 `0.25×宽`）

**验证**：裸窗口 360 点宽、完全落在单屏内遍历所有位置 → 异常 **0** 个；故意骑缝仍会被挪（对照）。
运行时探针：`innerWidth 180×244`、`margin {t:45,r:0,b:90,l:0}`、面板 `left=0px`、
夹取 `900→576 / -50→0 / 1600→1600` 全部符合预期。

### 坑 24（架构）：改为「覆盖整个桌面的静态窗口」

**问题**：只要窗口跟着宠物移动，跨屏就必然出现"顶在旧屏边缘 / 松手才跳过去 / 被系统挪走闪烁"。
即使把窗口缩到宠物宽度、加了归属屏夹取，也只能把跳变从 188px 压到 ~90px —— 这是架构决定的。

**Codex 的做法**（issue #43404 逆向）：一个 native 窗口按"最高的那块屏"开、顶端可为负 Y，
宠物只是窗口内部移动的 sprite。窗口根本不动 ⇒ 没有窗口骑缝、没有跨屏换窗、没有系统挪窗。

**本次重构**：

| 模块 | 改动 |
|---|---|
| main | `BrowserWindow` = 桌面外接矩形（hull），**固定不动**；显示器变化才重挂尺寸；`pet:set-bounds` 不再移动窗口，只登记身体矩形（点击穿透兜底）与碰撞状态 |
| sprite | `sendBounds` 改为窗口内定位元素（`el.style.left/top = pos`）；删除归属屏夹取/锁定/转移与窗口几何换算；只保留「别掉进无屏空洞」兜底；`onMouseMove` 命中判定改为「窗口坐标 − pos」；`visibleClampRect` 直接用宠物所在屏 |
| sessions-panel | `reposition` 重写：同坐标系居中 + 夹进所在屏，删除窗口/余量换算、参考屏迟滞、150ms 稳定判定 |
| pointer-target | 穿透判定改为「光标是否在宠物身体矩形内」 |
| preload | `setBounds(boxX, boxY, size, bottomPad, vx, vy)`，全部屏幕点 |

**收益**：跨屏 = 同一窗口内移动，天然连续；拖拽不再需要光标兜底（指针始终在同一窗口内）；
面板位置恒为"宠物中心 − 90"，没有边界翻转类闪烁。

**验证**（CDP 真实鼠标事件驱动探针实例）：
- 视口 2036×707（= 桌面外接矩形 / 2），sprite 元素定位在 `pos`，面板 `left = pos.x`（居中）
- 拖拽 552 → 1114 跨过 756 屏缝**连续跟随**，松手停在 1114
- 拖到无屏空洞 (300,60) → 被夹回可见屏 (244,217)
- `petBridge` 正常、无 JS 错误

**已知待验证**：真实桌面下的点击穿透、右键菜单/对话弹窗、多显示器几何变化、多宠物场景。

### 坑 25：macOS 对"超大窗口"的两条硬约束（大窗口架构的两个必须项）

用裸 Electron 逐项对照后发现，macOS 对大窗口有两条约束，缺一就会显示错位/点不到：

| 条件 | 结果 |
|---|---|
| 未开 `enableLargerThanScreen` | 4072×982 窗口被压成主屏工作区 `(0,38,1512,895)`，或被挪到 `(1512,-433)` |
| 开了 `enableLargerThanScreen`，但**原点 y < 0** | 位置被改成 `(2560,-904)` 之类（系统约束帧） |
| 开了 `enableLargerThanScreen`，原点 y ≥ 0 | **完全保持** ✅ |

**结论（helper 的两个必须项）**：

1. `new BrowserWindow({ ..., enableLargerThanScreen: true })`；
2. 窗口矩形上边夹到 `y ≥ 0`：`petWindowRect()` 返回
   `{ x: hull.x, top: Math.max(hull.y,0), width: hull.width, height: hull.y+hull.height-top }`。
   下发给渲染端的 `hull`（VIEW）必须用这个窗口矩形，否则 `pos` 与窗口原点不一致 →
   身体矩形整体偏移 → 点击穿透永不翻转（"点不到宠物"）。

**代价**：显示器布局里高于主屏顶边的部分（本机副屏的上方 458 点）不会被窗口覆盖，
宠物在那条带里不可见。彻底解决需要"每块屏一个窗口"，留作后续。

**诊断**：主进程每 0.5s 把 `{ignore, cursor, body, bounds, hull, setBoundsCount}` 写到
`~/.dsh/dsh-pet-click-diag-<pid>.json`（用户点不到时无法用右键菜单复制诊断，只能主动落盘）。

### 坑 26（最终架构）：窗口 = 宠物当前所在的那块显示器（Codex 同款）

**动机**：单窗口跨屏在 macOS「显示器有独立 Space」下会被裁到一块屏（实测红色覆盖只有副屏下半段；
窗口 bounds 说是 (0,0) 4072×982，实际只合成一部分）。而 Codex/ChatGPT 桌面版**不是**跨屏大窗口 ——
把它的宠物拖到副屏前后对比窗口 bounds：

```
主屏时: ChatGPT layer=3 bounds=(0,0) 1512x982
副屏时: ChatGPT layer=3 bounds=(1512,-458) 2560x1440
```

⇒ **单个窗口、大小 = 当前所在显示器，跨屏时整窗搬家。**

**实现**：

| 位置 | 改动 |
|---|---|
| main | `displayRectFor(point)`；创建窗口用主屏；`winDisplayId` 记录当前屏；`pet:set-bounds` 里按"宠物中心在哪块屏"决定是否 `setContentBounds` 搬家，并下发 `pet:displays`（hull=新屏 + **anchor=宠物包围盒绝对屏幕点**） |
| renderer | `pet:displays`：应用新 VIEW 后按 anchor 重新落位（窗口 resize 事件里**什么都不做**） |
| sprite | `screenPoint()` / `placeAtScreen(anchor)`；`sendBounds` **不夹窗口边界**（要允许越界才能触发换屏） |

**踩过的两个坑**（都在调试中修掉）：
1. 窗口 resize 时 `position()` 会把宠物重置回 `customPos`，用旧位置触发**反向搬屏**（1→2 后立刻 2→1）。→ 搬迁后 700ms 静默期 + resize 事件不做位置重置。
2. 保位不能靠渲染端自己记录（resize 先把位置改了）→ 由主进程下发绝对 anchor。

**验证**（CDP 驱动探针）：
```
请求宠物到屏幕点 (2600,800)
→ [display switch 1 -> 2]，窗口搬到副屏 2560×1440，视口 1280×720
→ 落位 pos=(544,629) ⇒ 屏幕点仍是 (2600,800) ✅
```

**收益**：窗口永远等于一块屏 → 不跨屏 → 不受 macOS 约束；宠物在窗口内移动 → 拖拽/漫游无窗口抖动；
跨屏只在中心进入另一块屏时发生一次整窗搬家。
