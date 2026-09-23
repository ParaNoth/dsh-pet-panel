# dsh-pet-panel

> **这是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet) 的 fork**，在原版桌宠上加了「会话面板」：常驻显示每个 DSH 会话的状态，**点击即切会话**。
> 上游原版说明见 [`README.upstream.md`](./README.upstream.md)；改了什么、为什么这么改见 [`CHANGELOG.fork.md`](./CHANGELOG.fork.md)。

---

这是 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（v0.2.11）的一个 fork，在原有桌面宠物基础上加了**一块会话状态面板**：常驻在宠物旁边，显示每个 DSH 会话的项目名、状态、口语化文案与待办进度，**点击某一行即可切到对应会话**，还能显示余额、按需关闭。

## 一句话说明它解决什么

原版 dsh-pet 会跟随 DSH 会话事件切换动画、在头顶弹一句状态气泡。但气泡是一次性的、看完即消失，也**不能点击跳转**。本 fork 把这些信息收进一块可交互的面板：

- 常驻显示（不会看完就没），只有你点 × 才消失
- 一行一个会话，**点行即切会话**
- 余额也作为一条通知行显示（刷新页面后至少有个框，不用先发消息才看得到）
- 宠物头顶的气泡因此可以关闭，把空间让给面板

面板长这样（文字描述，你装上就能看到）：

```
┌────────────────────────────────────┐
│ DSH        ⟲                    2  │   ← 标题 / 恢复按钮 / 计数
├────────────────────────────────────┤
│ ● 余额                 余额 ¥10976.62 │   ← 余额通知行（可 × 关闭）
│ ● dsh_construct  工作中     3/7      │   ← 一行一个会话
│   这一步正在进行中哦                  │   ← 口语化状态文案（原气泡内容）
└────────────────────────────────────┘
```

鼠标移到某行 → 右上角出现 `✕`（关闭该行）；点头部 `⟲` → 恢复所有被关闭的行。

## 功能清单

| 功能 | 说明 |
|---|---|
| 会话面板 | 与宠物**同一个窗口**里的 DOM 组件（不是独立窗口），自动跟随宠物移动/跨屏/挤压 |
| 点击跳转会话 | 点某行 → 宿主打开 `?session=<id>` 深链 → 页面端插件调用 `ctx.sessions.open(id)` |
| × 关闭 / ⟲ 恢复 | 关了就关（纯内存记录，重启即清），点头部 ⟲ 一键全部恢复 |
| 余额通知行 | `id = __balance__` 的普通行，复用同一套关闭/恢复；未登记的服务商显示明确说明而非静默 |
| 状态文案 | 宿主按「任务详情 → 该档位配置文案」算好下发，替代原来的头顶气泡 |
| 通知持久 | 面板不自动消失；宿主终态保留 24 小时（原版 60 秒） |
| 居中 + 贴边让位 | 面板默认**居中于宠物**；贴到屏幕边缘时整体平移收进来（clamp），不会被裁，**不影响宠物跨屏移动** |
| 设置页开关 | 「设置 → Plugins → Plugin configuration → DeepSeek Pet · 会话面板」：面板显示总开关，写完立即生效（位置是算出来的，不需要配） |
| 气泡开关 | `__dshPetBubbleEnabled = false` 关闭宠物头顶气泡（面板承接其内容） |

## 与上游的差异（改了哪些文件）

### 宿主侧（`lib/index.js`）

| 改动 | 作用 |
|---|---|
| 新增 `GET /dsh-pet-7340/sessions` | 每个活动会话一行：`{id, state, project, task, workText, todoDone, todoTotal}`，按展示优先级排序 |
| 新增 `POST /dsh-pet-7340/open-session` | 面板点击时登记"待打开会话"（带一次性 nonce，供页面轮询领取并 ack） |
| 新增 `workTextOf()` | 算"宠物本来会显示的那句状态文案"：任务详情优先，否则取 `workStatusTexts` 该档位随机一句 |
| 新增 `dsh-pet` 设置命名空间 | `installSection` 注册 `{enabled}`（可选依赖：用 `ctx.inject(['settings'])`，设置服务不在时行为完全不变）；`readAllConfig(paths, panel)` 把设置页的值叠加到文件配置之上 |
| per-session 任务/待办追踪 | 原来 `workStatus.task` 只记录"当前展示会话"，改为按会话各自记录 |
| 终态保留 60s → 24h | 用户要求"通知只在被关闭时消失"，不再自动蒸发 |

### 宠物窗口渲染端（`runtime/electron-helper/`）

| 文件 | 改动 |
|---|---|
| `sessions-panel.js` | **新增**：面板组件（轮询 `/sessions` 与 `/balance`、渲染行、× 关闭、⟲ 恢复、空态提示）；`reposition()` 按 `clamp(居中位置, 窗口∩工作区)` 摆放（居中优先、越界平移）；`refreshSettings()` 跟着会话轮询读 `/config` 的面板开关（关闭时连请求一起停） |
| `index.html` | **新增**：面板样式（深色毛玻璃，尺寸跟 `--pet-size` 等比；位置全部消费 `reposition()` 下发的 CSS 变量）+ 挂载脚本 |
| `constants.js` | **新增**：`__dshPetInteractiveRegions` 可交互区注册表 + `interactiveRegionAt()` |
| `sprite.js` | 命中判定纳入面板矩形；命中面板时上报 `setInputBusy`（保持窗口可交互，否则点击被穿透）；`--pet-size` 同时设到根元素（面板要能读到）；`sendBounds()` 末尾调用 `reposition()`（宠物移动的唯一出口） |
| `renderer.js` | 实例化面板 + `__dshPetBubbleEnabled = false` 关闭头顶气泡；暴露 `window.__dshPetSprite` 供面板在 side 变化时重算方位 |
| `preload.js` / `main.js` | 仅保留原有通道（诊断用的 `pet:log` 已清理） |

### 客户端 bundle（`lib/client.js`）

上游发布包**不含构建配置**（`tsdown.config.ts` / `tsconfig.json` 都不在 tarball 里），所以无法用原流水线重新构建。这里改为**注入式**：

- `lib/client.base.js` —— 上游原 bundle 的**原样备份**（135,546 B）
- `scripts/inject-deeplink.py` —— 对备份做两处注入，产出 `lib/client.js`：
  1. `inject` 数组补 `"sessions"`（深链要 `ctx.sessions.open(id)`，声明为硬依赖后 Cordis 会等服务就绪再 apply）
  2. `apply` 函数体内插入深链处理（读 `?session=` → 调 `ctx.sessions.open`，带等待型重试）
- `scripts/build-client.sh` —— 调用上面的注入脚本，产出 `lib/client.js`

> **为什么不"包装 factory"**：客户端 bundle 是经典 `<script>`（非模块），顶层没有 `require`（浏览器里是 `undefined`）。在顶层调用原 factory 会抛 `require is not a function` 并**打断整个 bundle**（连宠物本体一起消失）。运行期劫持 `pendingQueue`/`load` 也不可靠（加载器排空队列与脚本执行的时序无法从 bundle 内部保证）。注入进 `apply` 是唯一稳妥的形态。

## 目录结构（相对上游的变化）

```
lib/
  client.base.js          ← 新增：上游原 bundle 备份
  client.js               ← 由 scripts/build-client.sh 生成（注入深链）
  index.js                ← 宿主侧（改了：新增两个端点 + workText）
runtime/electron-helper/
  sessions-panel.js       ← 新增：面板组件
  index.html              ← 改了：面板样式与脚本
  constants.js            ← 改了：可交互区注册表
  sprite.js               ← 改了：命中判定纳入面板
  renderer.js             ← 改了：实例化面板 + 关气泡
scripts/
  build-client.sh         ← 新增
  test-panel-geometry.mjs ← 新增：面板位置回归测试（npm run test:panel，含变异测试验证过）
  inject-deeplink.py      ← 新增：对 base bundle 做四处注入（锚点找不到会报错退出、可重复执行保护）
  panel-settings-card.js  ← 新增：设置卡片源码（被 inject-deeplink.py 原样插进 client.js）
  sync-to-profile.sh      ← 新增：把本仓库同步到 DSH profile 的安装副本
```

> 注意：注入后的产物 `lib/client.js` 是**生成物**，不要手改 —— 改 `scripts/panel-settings-card.js`
> 或 `scripts/inject-deeplink.py` 后重跑 `bash scripts/build-client.sh`。

## 安装

依赖 DSH 环境（`dsh` CLI 可用）。两种方式：

```bash
# 方式一：直接指向本目录（推荐，源码即安装源）
dsh plugin --profile web add file:/path/to/dsh-pet-panel

# 方式二：先 clone 到本地再用 —— 不需要 npm install / 构建
git clone <this-repo> ~/Work/dsh-pet-panel
dsh plugin --profile web add file:~/Work/dsh-pet-panel
```

> `file:` / `link:` 安装都**不需要** `npm install`：`lib/` 里已有构建产物，`scripts/` 里没有构建步骤。
> 只有当你修改了 `runtime/electron-helper/*`（宠物窗口渲染端）时，才需要下面的"开发流程"。

安装后重启 `dsh web`，面板会出现在宠物旁边。

## 开发流程

改不同地方，生效方式不同：

| 改了什么 | 需要做什么 |
|---|---|
| `runtime/electron-helper/*`（面板/渲染端） | `npm run test:panel` → `bash scripts/sync-to-profile.sh` → 重启 `dsh web` |
| `lib/index.js`（宿主） | `bash scripts/sync-to-profile.sh` → 重启 `dsh web` |
| `scripts/inject-deeplink.py` 或 `scripts/panel-settings-card.js`（客户端注入） | `bash scripts/build-client.sh` → `bash scripts/sync-to-profile.sh` → 重启 `dsh web` → 页面**硬刷新** |
| 设置项（`dsh-pet` 命名空间 / 卡片） | 同上；只有设置页文案变化时也要重跑 build-client |

`sync-to-profile.sh` 是必需的：`dsh plugin add file:` 对已存在的依赖是**空操作**，而编辑源码会打断 pnpm 建立的硬链接 —— 两者叠加就是"改了代码但装的是旧的"（实测踩过）。也可以先 `bash scripts/sync-to-profile.sh --check` 只看差异。

## 已知限制

- **深链依赖页面重新加载**：点面板会打开 `?session=<id>`，页面加载时由客户端插件完成切会话。同标签页内如果已在跑轮询通道（`/open-session`），也可以不重新加载。
- **面板只在有内容时显示**：没有任何会话、也没取到余额时会整块隐藏（可用余额行保证"总有内容"）。
- **上游同步成本**：`lib/client.base.js` 是上游 bundle 的快照。上游升级时，需要重新取一份 bundle 覆盖它，再跑 `scripts/build-client.sh`；`lib/index.js` 与 `runtime/electron-helper/*` 的改动需要按上表手工合并。
- **macOS 桌面模式**：辅助功能权限可能被系统要求（拖拽宠物用），按提示授权即可。

## 上游与许可

- 上游：<https://github.com/PC2005-cloud/dsh-pet>（v0.2.11）
- 本 fork 沿用上游 LICENSE（见 `LICENSE`）
- 动画素材版权归上游作者，本仓库原样保留，未做修改

## 变更记录

改动过程与每个 bug 的根因都记在 `CHANGELOG.fork.md`（含"为什么这么做"的取舍说明），便于日后回看与上游同步时对照。
