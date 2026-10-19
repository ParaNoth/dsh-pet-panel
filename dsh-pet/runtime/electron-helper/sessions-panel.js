/**
 * dsh-pet desktop helper —— 会话面板（宠物窗口内的 DOM 组件）
 *
 * 设计（方案 A：与宠物同一个窗口）：
 *   - 面板是宠物窗口里的一个**兄弟 DOM 节点**，不是独立窗口 —— 所以它天然跟随宠物窗口移动，
 *     不需要跨进程锚点文件/贴合轮询（那些是"两个窗口"方案才需要的补偿机制）。
 *   - 位置：窗口顶部（canvas 顶边上方那段余量区），靠右对齐；宽度受窗口可用宽度约束。
 *   - 交互：面板矩形由会话面板自己报告（`getBounds()`），sprite 的命中判定把它纳入可交互区，
 *     所以行的点击不会被"整窗点击穿透"吃掉。
 *   - 数据：直接 `fetch(BASE + '/sessions')`（BASE 已按 bridge/HTTP 两种模式解析好），
 *     与宿主 `/dsh-pet-7340/sessions` 同一份数据源；点击行则 POST `/open-session` 请求宿主
 *     让页面侧插件切到该会话。
 *
 * 文案来源：宿主 /sessions 给的 `workText`（= 宠物原本在头顶气泡里显示的那句：优先任务详情，
 * 否则是配置里该档位的随机文案）。因为气泡已关闭（renderer.js 的 __dshPetBubbleEnabled=false），
 * 这些文案改由本面板承接，不再占用宠物头顶空间。
 *
 * 依赖：constants.js 的 BASE / CONFIG（经典 script 全局，加载顺序见 index.html）。
 */
'use strict';

/** 轮询周期：与面板独立版一致（1.5s；提醒不需要更急） */
const SESSIONS_POLL_MS = 1500;
/** 余额通知行的固定 id：不是会话（session = null），只是一条可关闭的通知 */
const BALANCE_ROW_ID = '__balance__';
/** 余额轮询周期：与配置的余额刷新周期同量级即可（拿到新值就更新那一行） */
const BALANCE_POLL_MS = 60 * 1000;
/** 面板自然宽度（DIP）：与 index.html 里 .dsh-sess-panel 的 width 一致，仅作可读性参考 */
const PANEL_NATURAL_W = 180;
/** 距屏幕工作区边缘的最小留白（避免面板边框正好被切在屏幕边上） */
const EDGE_PAD = 4;
/**
 * 读矩形的宽/高，兼容两种字段命名。
 *
 * 渲染端里同时存在两套矩形：`VIEW` 是 `{x, y, w, h}`，而 `AREAS`/`PANELS` 的元素是
 * `{x, y, width, height}`（shared-core 的 translateRects 生成）。混用会静默得到 undefined，
 * 进而算出 NaN 边界 —— 不报错，只是位置全错，极难查（实测踩过一次）。
 *
 * @param rect 矩形对象
 * @param axis 'w' 或 'h'
 * @returns 数值；两者都缺失时返回 NaN（让调用方一眼看出是数据问题）
 */
function rectSize(rect, axis) {
  if (!rect) return NaN;
  const a = axis === 'w' ? rect.width : rect.height;
  const b = axis === 'w' ? rect.w : rect.h;
  const v = a !== undefined ? a : b;
  return typeof v === 'number' ? v : NaN;
}
/** 请求超时：宿主重启中不能把渲染端卡住 */
const SESSIONS_TIMEOUT_MS = 4000;
/** 需要高亮的档位：等待确认 / 出错（面板列出全部会话，只把这两档标出来） */
const SESSIONS_ATTENTION = ['waiting', 'error'];
/** 档位 → 中文标签 */
const SESSIONS_LABEL = {
  // 余额通知行（session = null 的等价物）：项目名已写"余额"，状态词留空由渲染层跳过
  balance: '',
  waiting: '等待确认',
  error: '出错',
  working: '工作中',
  thinking: '思考中',
  result: '处理中',
  success: '完成',
};

/**
 * 关闭记录是否过期：**永不过期**。
 *
 * 用户明确要求"只有被关掉才消失，不要自动蒸发"——自动重新露出会让提醒失效。
 * 记录本身是纯内存的（重启即清），所以不会无限累积；面板的 ⟲ 也可随时全部恢复。
 */
function dismissExpired() {
  return false;
}

class SessionsPanel {
  /**
   * @param {HTMLElement} mount 挂载点（宠物窗口的 overlay 容器）
   */
  constructor(mount) {
    this.mount = mount;
    this.el = null;
    this.rowsEl = null;
    this.countEl = null;
    /** 宿主给的原始会话列表（唯一事实来源；渲染时的过滤不得写回这里） */
    this.rawSessions = [];
    this.lastSignature = '';
    this.draggedRecently = false;
    this.timer = null;
    /**
     * 已被用户点 × 关闭的会话：纯**内存**记录，重启即清。
     *
     * 为什么不做持久化（localStorage）：关掉的会话在刷新/重启后仍会被同一份记录过滤掉，
     * 一旦那条会话又出现，面板就会因为"过滤后为空"而整块消失 —— 这个坑实测踩了三次
     * （用户三次反馈"框体不见了"）。面板的存在感比"记住关闭"更重要，所以宁可不持久化。
     */
    this.dismissed = {};
    /** 余额通知行（id 固定为 BALANCE_ROW_ID，session = null）；无数据时为 null */
    this.balanceRow = null;
    /**
     * 面板设置（DSH 设置页 → `dsh-pet` 命名空间；宿主已合并到 /config 的 `main.petPanel`）。
     *
     *   enabled：false = 完全不显示面板，且停掉轮询（不是"隐藏但仍每 1.5 秒打宿主"）
     *
     * 位置不在这里：它是**算出来的**（居中优先、越界平移），没有可配项。
     */
    this.settings = { enabled: true };
    /** 已应用的设置序列化串：用来判断是否需要重绘（设置页改完 → /config 一变就生效） */
    this._settingsKey = null;
  }

  /**
   * 该会话当前是否被关闭。
   *
   * 语义：**关了就一直关**（在有效期内），不再因状态变化自动冒出来。
   * 早先写成"状态一变就重新露出"，结果用户点了 × 之后会话从 working 走到 success，
   * 那一行又回来了（实测反馈）。用户的预期很简单：我关了就是关了。
   * 会话真正结束时宿主会把它从 /sessions 里移除（终态保留 24h 后才清理），行自然消失。
   */
  isDismissed(session) {
    const rec = this.dismissed[session.id];
    if (!rec) return false;
    return !dismissExpired(); // 目前永不过期（见 dismissExpired 说明）
  }

  /** 关闭某一行（点 ×） */
  dismiss(session) {
    this.dismissed[session.id] = { ts: Date.now() };
    // 立刻重绘。**不要**先清 lastSignature：清成 '' 后，若过滤结果为空（正是"关掉最后一行"的场景），
    // 新签名也恰好是 ''，两者相等 → render 判定"内容没变"直接 return，行就留在屏幕上了（实测 bug）。
    // 正常重绘即可：过滤后的签名必然与上一次不同。
    this.render();
  }

  /**
   * 还能撤回的关闭记录（按关闭时间**倒序** = 最近关掉的排最前）。
   *
   * 只算"当前确实在列表里、且确实被过滤掉了"的那些：
   * 会话结束后会从 /sessions 消失，那种关闭记录已经无从恢复，不该再让 ⟲ 亮着
   *（否则点一下什么都不会发生，用户会以为按钮坏了）。
   */
  restorableDismissals() {
    return this.rawSessions
      .filter((s) => this.dismissed[s.id])
      .sort((a, b) => (this.dismissed[b.id]?.ts ?? 0) - (this.dismissed[a.id]?.ts ?? 0));
  }

  /**
   * 恢复**最近关掉的那一条**（点 ⟲）。
   *
   * 为什么不是"一次全恢复"：那样会把你之前每次"我确实不想看这条"的决定一起推翻，
   * 你只想救回刚误关的那条，却得把其余几条重新关一遍（用户实测反馈）。
   * 逐条撤（后进先出）对应"我刚点错了"这一真实场景，且不动更早的决定。
   *
   * @returns 恢复了哪一条（null = 没有可恢复的）
   */
  restoreLastDismissed() {
    const queue = this.restorableDismissals();
    if (queue.length === 0) return null;
    const target = queue[0];
    delete this.dismissed[target.id];
    this.render();
    return target;
  }

  /** 创建 DOM 并启动轮询；返回 this 便于链式调用 */
  start() {
    const card = document.createElement('div');
    card.className = 'dsh-sess-panel';
    card.hidden = true;
    card.innerHTML =
      '<div class="dsh-sess-head"><span>DSH</span>' +
      '<button type="button" class="dsh-sess-restore" title="显示被我关闭的行（清除关闭记录）">⟲</button>' +
      '<span class="dsh-sess-diag"></span>' +
      '<span class="dsh-sess-count"></span></div>' +
      '<div class="dsh-sess-rows"></div>';
    this.mount.appendChild(card);
    this.el = card;
    this.rowsEl = card.querySelector('.dsh-sess-rows');
    this.countEl = card.querySelector('.dsh-sess-count');
    this.diagEl = card.querySelector('.dsh-sess-diag');
    // 「恢复」入口：每点一次恢复**最近关掉的一条**（后进先出），不再一次全恢复。
    // 没有它的话，一旦误关又记不清关了哪些，面板可能看起来"什么都不显示"而无法自救；
    // 而"一次全恢复"又会把更早那些"确实不想看"的决定一起推翻（用户反馈）。
    // 无可恢复项时按钮置灰（见 syncRestoreButton），避免点了没反应让人以为坏了。
    this.restoreEl = card.querySelector('.dsh-sess-restore');
    this.restoreEl.addEventListener('click', (event) => {
      event.stopPropagation();
      const restored = this.restoreLastDismissed();
      if (restored === null) return;
      // 提示恢复了哪一条：逐条恢复时，用户需要知道"刚回来的是哪行"，否则容易连点
      this.restoreEl.title = '已恢复：' + (restored.project || restored.id) + '（再点恢复上一条）';
      window.setTimeout(() => this.syncRestoreButton(), 1500);
    });

    // 登记为"窗口内可交互区"：sprite 的命中判定据此把面板矩形纳入可交互区，
    // 否则面板在整窗穿透的余量区里，行的点击会被穿透吃掉（见 __dshPetInteractiveRegions 约定）。
    window.__dshPetInteractiveRegions.push((wx, wy) => {
      const b = this.getBounds();
      return (
        b !== null && wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h
      );
    });
    // 面板 hover 期间必须**保持可交互**：主进程有一条兜底通道（pointer-target.js 的
    // decideWindowIgnore），每 60ms 按真实光标位置判定，且它只知道"宠物身体"的命中区 ——
    // 光标停在面板上时它会把窗口翻回**点击穿透**，点击就永远到不了 DOM。
    // 用 setInputBusy(true) 顶住它（与宠物自己的菜单/对话弹窗同一套保护；busy 期间主进程绝不翻回穿透）。
    this.onPointerEnter = () => window.petBridge && window.petBridge.setInputBusy(true);
    this.onPointerLeave = () => window.petBridge && window.petBridge.setInputBusy(false);
    card.addEventListener('pointerenter', this.onPointerEnter);
    card.addEventListener('pointerleave', this.onPointerLeave);

    // 诊断：记录每一次窗口内点击是否落在面板矩形内（判断"点击没到按钮"还是"到了但没生效"）
    this.onClickCapture = (event) => {
      const b = this.getBounds();
      const inPanel =
        b !== null &&
        event.clientX >= b.x && event.clientX <= b.x + b.w &&
        event.clientY >= b.y && event.clientY <= b.y + b.h;
      };
    window.addEventListener('click', this.onClickCapture, true);

    // 捕获阶段拦下 pointerdown：窗内其它逻辑（宠物拖拽/点击）不得因面板上的按下而触发
    this.onPointerDownCapture = (event) => {
      const b = this.getBounds();
      if (b === null) return;
      if (
        event.clientX >= b.x &&
        event.clientX <= b.x + b.w &&
        event.clientY >= b.y &&
        event.clientY <= b.y + b.h
      ) {
        event.stopPropagation();
      }
    };
    window.addEventListener('pointerdown', this.onPointerDownCapture, true);

    void this.refresh();
    void this.refreshBalance();
    // 排障快照：宠物 DevTools 里执行 __dshPetDebug.snapshot() 即可拿到定位所需全部量
    window.__dshPetDebug = window.__dshPetDebug || {};
    window.__dshPetDebug.snapshot = () => {
      const sp = window.__dshPetSprite;
      const pos = sp && sp.pos ? { x: sp.pos.x, y: sp.pos.y } : null;
      const size = sp ? Number(sp.size) || 0 : 0;
      let areaIndex = -1;
      if (pos && AREAS && AREAS.length) {
        const cx = pos.x + size / 2;
        const cy = pos.y + size / 2;
        areaIndex = AREAS.findIndex(
          (a) => cx >= a.x && cx <= a.x + rectSize(a) && cy >= a.y && cy <= a.y + rectSize(a, 'h'),
        );
      }
      return {
        pos,
        center: pos ? { x: pos.x + size / 2, y: pos.y + size / 2 } : null,
        size,
        areaIndex,
        areas: AREAS,
        view: { x: VIEW.x, y: VIEW.y, w: VIEW.w, h: VIEW.h },
        panelLeft: this._appliedLeft,
        win: { w: window.innerWidth, h: window.innerHeight },
        lastDragRaw: window.__dshPetDebug.lastDragRaw,
        lastThrow: window.__dshPetDebug.lastThrow,
        // 运行版本身份：新版（并集 x）的 minX = −sideAllow；旧版（逐屏内缩）= 屏左 − sideAllow。
        // 一眼就能确认"跑的是不是刚部署的那版"（踩过：文件已更新但 helper 没重启）。
        bounds: (() => {
          const sp = window.__dshPetSprite;
          const space = sp && sp.space;
          if (!space || !Array.isArray(space.bounds)) return null;
          return space.bounds.map((b) => ({ minX: Math.round(b.minX), maxX: Math.round(b.maxX), minY: Math.round(b.minY), maxY: Math.round(b.maxY) }));
        })(),
        sideAllow: (() => {
          const sp = window.__dshPetSprite;
          return sp ? sp.sideAllow : null;
        })(),
        scale: CONFIG.scale,
      };
    };
    this.timer = window.setInterval(() => void this.refresh(), SESSIONS_POLL_MS);
    this.balanceTimer = window.setInterval(() => void this.refreshBalance(), BALANCE_POLL_MS);
    return this;
  }

  /**
   * 面板在**窗口局部坐标**下的矩形（命中判定用）。
   * 隐藏时为 null（此时窗口不该因面板而可交互）。
   */
  getBounds() {
    if (!this.el || this.el.hidden) return null;
    const r = this.el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  async refresh() {
    // 设置与数据一起拉：都在同一个轮询周期里，设置页改完最多 1.5s 生效。
    // 设置先应用再取数据，这样"刚被关掉"的那一轮就不会白渲染一次。
    await this.refreshSettings();
    if (!this.settings.enabled) {
      // 关掉面板时**连请求一起停**：面板是提醒器，用户明确说了不要就别再打宿主。
      this.rawSessions = [];
      this.balanceRow = null;
      if (this.el) this.el.hidden = true;
      return;
    }
    let sessions;
    try {
      const res = await fetch(BASE + '/sessions', {
        cache: 'no-store',
        signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('sessions HTTP ' + res.status);
      const data = await res.json();
      sessions = Array.isArray(data && data.sessions) ? data.sessions : [];
    } catch {
      // 宿主不可达（重启中/未装新端点）：收起面板，不弹错误——面板是提醒器，不该自己造噪音
      sessions = [];
    }
    // 只在这里更新"原始会话列表"：渲染内部自行过滤，绝不把过滤后的子集写回
    //（否则原始列表会随每次关闭/恢复越缩越小，真实环境里表现为"会话行莫名消失一会儿"）。
    this.rawSessions = sessions;
    this.render();
  }

  /**
   * 从宿主的 `/config` 读面板设置（`main.petPanel`）。
   *
   * 为什么不放在 renderer 的启动流程里一次性读取：设置页随时可能改，
   * 而渲染端只在启动时读一次 /config —— 挂在这里就等于"跟着会话轮询走"，无需重启宠物。
   * 读失败时**保持上一次的有效值**（宿主重启中不能把面板翻成默认值再翻回来）。
   */
  async refreshSettings() {
    let panel;
    try {
      const res = await fetch(BASE + '/config', {
        cache: 'no-store',
        signal: AbortSignal.timeout(SESSIONS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error('config HTTP ' + res.status);
      const merged = await res.json();
      panel = merged && merged.main ? merged.main.petPanel : null;
    } catch {
      return; // 保留上一次设置
    }
    const next = { enabled: !panel || panel.enabled !== false };
    const key = String(next.enabled);
    if (key === this._settingsKey) return;
    this._settingsKey = key;
    const wasEnabled = this.settings.enabled;
    this.settings = next;
    if (next.enabled !== wasEnabled) {
      // 开关一变立刻反映，不等下一轮数据（关：马上收起；开：马上拉一次数据）
      if (!next.enabled) {
        if (this.el) this.el.hidden = true;
      } else {
        void this.refreshBalance();
      }
    }
    // 开关切换后主动重排一次：位置没变时 reposition 会因去重跳过，而 hidden 状态刚变过
    this._posKey = null;
    if (window.__dshPetSprite) this.reposition(window.__dshPetSprite);
  }

  /**
   * 拉一次余额，转成"一条通知行"（session = null 的等价物）。
   *
   * 设计：把余额当成一条 `id = __balance__` 的普通行交给同一套渲染/关闭/恢复逻辑 ——
   * 所以它能被 × 关掉、能被 ⟲ 恢复，不需要另开一套常驻区域。
   * 失败（未登记该服务商 / 缺凭证 / 抓取失败）时也给一行说明，绝不静默。
   */
  async refreshBalance() {
    let row = null;
    try {
      const res = await fetch(BASE + '/balance', { cache: 'no-store' });
      const data = await res.json();
      const text = this.balanceText(data);
      if (text) row = { id: BALANCE_ROW_ID, state: 'balance', project: '余额', workText: text, task: null };
    } catch {
      row = null; // 宿主不可达：不显示余额行（其余会话行不受影响）
    }
    const changed = JSON.stringify(row) !== JSON.stringify(this.balanceRow);
    this.balanceRow = row;
    if (changed) this.render();
  }

  /**
   * 摆放面板：**优先居中于宠物，其次不越出边界**。
   *
   * 位置语义就一条：`clamp(居中位置, 可选范围)`。
   *   - 居中放得下 → 正好居中（默认情况，宠物在屏幕中间时就是这个）；
   *   - 居中会越界 → 整体平移到边界内侧停住，且是"离居中最近"的可行位置。
   *
   * 为什么不是"换边"：换边（贴在身体左/右侧）是排版语义，结果永远偏在一边 —— 实测反馈
   * "这个窗口直接偏了"。用户要的是居中优先、边界兜底，夹取才是这个语义。
   *
   * 为什么边界要同时看窗口和工作区两重：面板住在宠物窗口里，而窗口**不夹取**
   *（sendBounds 直接下发，宠物贴边时窗口跟着越出屏幕）—— 落在窗口外的部分会被 OS 裁掉，
   * 看不见；落在工作区外的部分则出屏。所以取两者的交集，再留 EDGE_PAD 避免贴着切边。
   * 让位只改面板在窗口内的位置，**宠物照常跨屏移动，不受任何影响**。
   *
   * @param sprite 宠物（提供 pos/margin/size），布局变化时调用
   */
  reposition(sprite) {
    if (!this.el || !sprite || !sprite.pos || !sprite.margin) return;
    // 去重：sendBounds 每帧都可能调用，位置没变就不重复动 DOM。
    // 除了位置还要带上工作区几何与窗口宽 —— 插拔显示器/改分辨率时宠物位置可能没变，
    // 但边界已经变了（少了这些，面板会继续按旧屏的余量摆放）。
    const waKey = (AREAS && AREAS.length)
      ? AREAS.map((a) => a.x + ':' + a.y + ':' + a.w + ':' + a.h).join('|')
      : '';
    const key = sprite.pos.x + ',' + sprite.pos.y + ',' + window.innerWidth + ',' + waKey;
    if (this._posKey === key) return;
    this._posKey = key;
    // 桌面几何变了（插拔屏/改分辨率/旋转）：迟滞与"上次参考屏"必须作废，
    // 否则宠物没动、只换了屏的情况下，新的正确位置会被迟滞一直挡掉。
    if (this._geoKey !== waKey) {
      this._geoKey = waKey;
      this._area = null;
      this._appliedLeft = undefined;
      this._pendingLeft = undefined;
      this._pendingSince = undefined;
    }
    const size = Number(sprite.size) || 0;
    if (size <= 0) return;

    // ---- 位置：以宠物中心为基准居中，只在会越界时**平移收进来**（夹取，不是换边）----
    //
    // 为什么是夹取而不是"换边"：换边是"贴在身体左/右侧"的排版，结果永远偏在一边
    //（实测反馈："这个窗口直接偏了"）。用户要的是**优先居中，其次不越界**，
    // 这正是 clamp(理想位置, 下界, 上界) 的语义 —— 居中放得下就居中，
    // 放不下才贴着边界停住，且始终是"离居中最近"的那个位置。
    //
    // 边界要考虑两重裁切：窗口被 OS 裁掉的部分（面板在窗口外就看不见），
    // 以及工作区边缘。所以下界/上界同时受这两者约束。
    const winW = window.innerWidth;                            // 窗口宽（恒 ≈ 2×size）
    const winH = Number(sprite.winH) || window.innerHeight || VIEW.h; // 窗口高
    if (!(winW > 0)) return;
    // 窗口左/上缘，**与 AREAS 同一坐标系**：AREAS 是「外接矩形原点」相对坐标
    //（= 屏幕坐标 − VIEW 原点），sprite.pos 也已经是这个坐标系里的值。
    // 旧写法额外加 VIEW.x/y 得到屏幕坐标，再与 AREAS 比较 —— 单屏或外接矩形原点为 0 时恰好
    // 等价，多屏且原点非 0（如左侧还有一块屏）就会算错夹取边界。
    const winLocalL = sprite.pos.x - sprite.margin.l;
    const winLocalT = sprite.pos.y - sprite.margin.t;
    const winR = winLocalL + winW;
    const winB = winLocalT + winH;

    // ---- 允许范围：**与窗口相交的所有屏**的并集外包 ----
    // 为什么不是"宠物中心所在那块屏"：宠物骑在屏缝上时（很常见），居中位置会跨到相邻屏，
    // 而两块屏**都在可视范围内**。按单屏夹取会把面板硬推进当前屏内、看起来"不居中"
    //（实测：宠物中心 x=799、第二屏从 756 开始 → 面板被推到 left=141，而居中应是 90）。
    // 取并集外包后，跨缝居中不再被误夹。
    //
    // ⚠️ 字段名陷阱：AREAS 的元素是 {x, y, width, height}（shared-core 的 translateRects 生成），
    // 而 VIEW 用的是 {x, y, w, h} —— 读宽高一律走 rectSize() 兼容两种命名。
    let boundL = Infinity;
    let boundR = -Infinity;
    let boundT = Infinity;
    let boundB = -Infinity;
    for (const a of AREAS) {
      const aw = rectSize(a);
      const ah = rectSize(a, 'h');
      if (a.x + aw <= winLocalL || a.x >= winR) continue; // 与窗口无横向交集
      boundL = Math.min(boundL, a.x);
      boundR = Math.max(boundR, a.x + aw);
      boundT = Math.min(boundT, a.y);
      boundB = Math.max(boundB, a.y + ah);
    }
    if (!Number.isFinite(boundL)) {
      // 极端兜底：窗口不与任何屏相交 → 退回宠物中心那块屏（保持旧行为）
      const wa = this.desktopRect(sprite);
      boundL = wa.x;
      boundR = wa.x + rectSize(wa);
      boundT = wa.y;
      boundB = wa.y + rectSize(wa, 'h');
    }
    const waRight = boundR; // 供下方几何自检使用

    // 宠物**视觉中心**：包围盒中心（命中框中心即包围盒中心），面板以它为基准才对齐身体
    const bodyCx = sprite.pos.x + size / 2;
    const idealLeft = bodyCx - PANEL_NATURAL_W / 2;

    // 左界：不能越过窗口左缘与可视区域左缘；右界同理（都要留 EDGE_PAD）
    const minScreenL = Math.max(winLocalL, boundL) + EDGE_PAD;
    const maxScreenL = Math.min(winR, boundR) - PANEL_NATURAL_W - EDGE_PAD;
    // 上界可能小于下界（窗口窄到放不下面板时）：取"离居中最近"的可行值，宁可略微出界也不夹成负数
    const screenL = maxScreenL >= minScreenL
      ? Math.min(Math.max(idealLeft, minScreenL), maxScreenL)
      : (idealLeft < minScreenL ? minScreenL : maxScreenL);
    // ---- 时间迟滞：位置只微小变化时，禁止面板大幅横跳 ----
    // 宠物在多屏接缝上来回轻微移动（漫游反复试走/物理回弹）时，参考屏会在两块屏之间翻面，
    // 而两块屏的夹取基准差得远（实测 90px 级）——表现就是"面板一直闪"。
    // 规则：本次目标与上次已应用值相差 > JUMP 时，只有宠物**累计移动**超过 MOVE 才接受新的位置；
    // 否则保持不动。真走路跨屏时位移会持续累积，很快越过 MOVE，不会卡住。
    // 硬性兜底：不论上面的边界算出什么，面板**永远留在窗口画布内**。
    // （跨屏拖动时曾出现"面板被挤出画布"：边界用的是并集，一旦窗口几何与屏幕几何换算有偏差，
    //   算出的 left 可能超出 [0, winW-面板宽]，溢出部分直接不可见。这一夹取与几何正确性无关。）
    const maxLeft = Math.max(0, Math.round(winW - PANEL_NATURAL_W));
    const wantedLeft = Math.min(Math.max(Math.round(screenL - winLocalL), 0), maxLeft);
    const PANEL_JUMP_EPS = 24;
    const PANEL_SETTLE_MS = 150;
    const nowMs = performance.now();
    if (this._appliedLeft !== undefined && Math.abs(wantedLeft - this._appliedLeft) > PANEL_JUMP_EPS) {
      // 大幅跳变：同一目标必须连续稳定 PANEL_SETTLE_MS 才应用。
      // 真正跨屏走路时宠物会在新位置稳定下来，150ms 内自然被接受（不卡死）；
      // 而在接缝/空洞边缘来回抖时目标每帧都变，永远等不到稳定 —— 面板纹丝不动。
      if (this._pendingLeft !== wantedLeft) {
        this._pendingLeft = wantedLeft;
        this._pendingSince = nowMs;
        return;
      }
      if (nowMs - (this._pendingSince || 0) < PANEL_SETTLE_MS) return;
    }
    this._pendingLeft = undefined;
    this.el.style.setProperty('--sess-panel-left', wantedLeft + 'px');
    this._appliedLeft = wantedLeft;
    // ---- 几何自检（有意保留，不是调试残留）----
    // 渲染端没有任何日志通道（主进程写文件在这台机器上静默失败、devtools 也不在跟前），
    // 所以把「边界算坏了」这件事**画在标题栏上**：健康时留空、完全不占地方，
    // 只有 screenL / waRight / winLocalL 出现非有限值时才显示 GEOM BAD + 关键量。
    // 价值已被验证：面板偏左那次就是靠它读出 "wa0-NaN"，一眼定位到 AREAS 的
    // 宽高字段名读错（详见 CHANGELOG.fork.md「坑 3」）。
    if (this.diagEl) {
      const healthy = Number.isFinite(screenL) && Number.isFinite(waRight) && Number.isFinite(winLocalL);
      this.diagEl.textContent = healthy
        ? ''
        : 'GEOM BAD win' + Math.round(winW) +
          ' pet' + Math.round(size) + '@' + Math.round(sprite.pos.x) +
          ' left' + Math.round(screenL - winLocalL) +
          ' wa' + Math.round(wa.x) + '-' + waRight;
    }

    // 竖直方向同理：理想位置是窗口顶部那 4px，越界时往下让（贴着工作区上缘）
    const minTop = Math.max(winLocalT, boundT) + EDGE_PAD;
    this.el.style.setProperty('--sess-panel-top', Math.round(minTop - winLocalT) + 'px');
    const roomH = boundB - minTop - EDGE_PAD;
    if (Number.isFinite(roomH)) {
      this.el.style.setProperty('--sess-avail-h', Math.round(Math.max(0, roomH)) + 'px');
    }
  }

  /**
   * 取宠物所在显示器的工作区（视口相对）；落在空洞里时退到最近的一块，避免拿错屏的边界。
   *
   * ⚠️ 返回的矩形用 **width/height** 命名（与 AREAS/translateRects 一致），读取请走 `rectSize()`。
   */
  desktopRect(sprite) {
    const size = Number(sprite.size) || 0;
    const cx = sprite.pos.x + size / 2;
    const cy = sprite.pos.y + size / 2;
    const S_ = typeof S !== 'undefined' ? S : null;
    // 兜底：AREAS 未就绪时把整个视口当一块屏（命名与 AREAS 保持一致）
    if (!(AREAS && AREAS.length)) return { x: 0, y: 0, width: VIEW.w, height: VIEW.h };
    // 1) 点位落在某块屏内：直接用
    if (S_ && typeof S_.rectAtPoint === 'function') {
      const hit = S_.rectAtPoint(AREAS, cx, cy);
      if (hit) {
        this._area = hit;
        return hit;
      }
    }
    // 2) 落在**空洞**里（多屏外接矩形中不被任何屏覆盖的区域）：
    //    粘住上一次选中的屏，只有明显离开（超过一个宠物身位）才重新选。
    //
    //    为什么必须粘：宠物在接缝/空洞边缘轻微移动时，`resolveRect` 的"最近屏"会在两块屏
    //    之间来回翻；而两块屏的夹取基准（wa.x / waRight）差得很远，面板就会在两个位置之间
    //    **持续闪烁**（实测：第二屏左缘正好是空洞边界）。粘滞把这个二值翻转变成带容差的判断。
    const last = this._area;
    if (last && AREAS.indexOf(last) !== -1 && S_ && typeof S_.distToRectSq === 'function') {
      const tol = Math.max(40, size);
      if (S_.distToRectSq(last, cx, cy) <= tol * tol) return last;
    }
    const r = S_ && typeof S_.resolveRect === 'function' ? S_.resolveRect(AREAS, cx, cy) : null;
    const picked = r || AREAS[0];
    this._area = picked;
    return picked;
  }

  /** 把 /balance 的响应转成一行文案（provider 未登记时明确说明原因，不静默） */
  balanceText(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.ok === true && data.kind === 'deepseek' && data.data) {
      const cur = data.data.currency === 'CNY' ? '¥' : String(data.data.currency || '') + ' ';
      return '余额 ' + cur + String(data.data.total);
    }
    if (data.ok === true && data.kind === 'opencode' && data.data) {
      // 取最先告急的一个窗口
      const parts = [
        ['5 小时', Number(data.data.rolling)],
        ['周', Number(data.data.weekly)],
        ['月', Number(data.data.monthly)],
      ].filter(([, v]) => Number.isFinite(v));
      if (parts.length === 0) return null;
      parts.sort((a, b) => b[1] - a[1]);
      return parts[0][0] + '额度已用 ' + Math.round(parts[0][1]) + '%';
    }
    // 未登记 / 缺凭证 / 抓取失败：明确说出原因
    const reason = data.reason === 'unsupported'
      ? '当前服务商暂不支持余额查询（' + String(data.provider || '?') + '）'
      : data.reason === 'credential-missing'
        ? '缺少凭证：' + String(data.message || '')
        : '余额获取失败：' + String(data.message || data.reason || '未知原因');
    return reason;
  }

  /** 计算"当前该显示的行 + 其签名"（过滤已关闭的会话；签名含 workText 与关闭状态） */
  visibleRows(sessions) {
    // 余额行（若已取到）并入列表首位：它是 session = null 的通知行，走同一套过滤与关闭逻辑
    const all = this.balanceRow ? [this.balanceRow, ...sessions] : sessions;
    const shown = all.filter((s) => !this.isDismissed(s));
    // 注意：这里**不能**加"过滤空了就全显示"的兜底 —— 那会把用户刚点的 × 当场抵消
    // （实测：点 × 后计数变 d1 但行不消失）。防空白由 TTL 兜底 + ⟲ 恢复入口负责。
    const signature = shown
      .map((s) => [s.id, s.state, s.project, s.task, s.workText, s.todoDone, s.todoTotal].join('|'))
      .join('~');
    // 空可见集要给一个**非空签名**：否则它与"刚启动时 lastSignature=''"相同，
    // render 会判定"内容没变"直接 return —— 空态提示和 ⟲ 恢复都会画不出来（实测 bug）。
    return { shown, all: all.length, signature: signature === '' ? '__empty__' : signature };
  }

  /**
   * 同步 ⟲ 的可用状态与提示。
   *
   * 逐条恢复之后，"还有几条能撤回"变成关键信息：按钮不置灰的话，
   * 点到底会变成"点了没反应"，用户只会以为坏了。
   */
  syncRestoreButton() {
    if (!this.restoreEl) return;
    const n = this.restorableDismissals().length;
    this.restoreEl.disabled = n === 0;
    this.restoreEl.title = n === 0
      ? '没有可恢复的行（关闭的会话结束后就无法恢复了）'
      : '恢复最近关闭的 1 行（还可恢复 ' + n + ' 行）';
  }

  render() {
    // 设置页把面板关掉时，任何一次重绘都不许把它放回屏幕（render 的各个分支都会写 el.hidden）
    if (!this.settings.enabled) {
      if (this.el) this.el.hidden = true;
      return;
    }
    const sessions = this.rawSessions;
    // 过滤 + 签名必须与 dismiss() 用同一份计算（否则点 × 后下一次轮询会把它画回来）
    const { shown, all, signature } = this.visibleRows(sessions);
    // 按钮可用性要在"提前 return"之前同步：会话静默结束时可见行没变化（签名相同），
    // 但"还能撤回几条"变了 —— 放在后面会让按钮状态僵住。
    this.syncRestoreButton();
    // 内容没变就不重绘：避免每 1.5s 重建 DOM 引起闪烁
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;

    this.rowsEl.replaceChildren();
    if (shown.length === 0) {
      // 用户把当前候选行都关掉了：显示一句明确的空态，而不是整块消失
      //（消失会让人以为"面板坏了"——实测反馈过两次），点头部 ⟲ 可恢复。
      // 判据用 all（候选总数 = 余额行 + 会话行），**不能**用 sessions.length ——
      // 余额行不在 sessions 里，"只关掉余额行"时曾因此走了隐藏分支（实测 bug）。
      if (all > 0) {
        const empty = document.createElement('div');
        empty.className = 'dsh-sess-empty';
        empty.textContent = '已全部关闭 · 点 ⟲ 逐条恢复';
        this.rowsEl.appendChild(empty);
        this.countEl.textContent = '0';
        this.el.hidden = false;
        return;
      }
      this.el.hidden = true;
      return;
    }
    const attentionCount = shown.filter((s) => SESSIONS_ATTENTION.includes(s.state)).length;
    // 头部计数 = 需要注意的会话数；全部正常时显示总数（一眼看出"几只在跑"）
    this.countEl.textContent = String(attentionCount > 0 ? attentionCount : shown.length);
    for (const session of shown) this.rowsEl.appendChild(this.renderRow(session));
    this.el.hidden = false;
  }

  /** 一行：圆点 + 项目名 + 状态 + 进度 + 任务文案 */
  renderRow(session) {
    const row = document.createElement('div');
    row.className = 'dsh-sess-row';
    row.title = '点击切到该会话';
    row.addEventListener('click', (event) => {
      event.stopPropagation();
      void this.openSession(session.id, row);
    });

    // 关闭按钮（×）：右上角，hover 行时出现。面板没有自动消失，必须给用户一个收起的入口。
    const close = document.createElement('button');
    close.className = 'dsh-sess-close';
    close.type = 'button';
    close.title = '关闭这一行';
    close.setAttribute('aria-label', '关闭这一行');
    close.textContent = '✕';
    close.addEventListener('click', (event) => {
      event.stopPropagation(); // 不要触发行的"跳转会话"
      this.dismiss(session);
    });
    row.appendChild(close);

    const dot = document.createElement('span');
    dot.className = 'dsh-sess-dot ' + String(session.state || '');
    row.appendChild(dot);

    const main = document.createElement('div');
    main.className = 'dsh-sess-main';

    const line1 = document.createElement('div');
    line1.className = 'dsh-sess-line1';
    const project = document.createElement('span');
    project.className = 'dsh-sess-project';
    project.textContent = String(session.project || '—');
    line1.appendChild(project);
    // 状态标签：显式给空串的档位（余额通知行）不渲染，避免"余额 balance 余额 ¥…"这种重复
    const labelText = SESSIONS_LABEL[session.state];
    const stateText = labelText !== undefined ? labelText : String(session.state || '');
    if (stateText !== '') {
      const state = document.createElement('span');
      state.className = 'dsh-sess-state';
      state.textContent = stateText;
      line1.appendChild(state);
    }
    const total = Number(session.todoTotal) || 0;
    if (total > 0) {
      const progress = document.createElement('span');
      progress.className = 'dsh-sess-progress';
      progress.textContent = `${Number(session.todoDone) || 0}/${total}`;
      line1.appendChild(progress);
    }
    main.appendChild(line1);

    const task = document.createElement('div');
    // 优先 workText（宿主按"任务详情 → 配置文案"算好的口语化文案，原本显示在宠物头顶气泡里）；
    // 取不到才回退到任务详情，最后才显示占位。
    const fromWork = typeof session.workText === 'string' ? session.workText.trim() : '';
    const fromTask = typeof session.task === 'string' ? session.task.trim() : '';
    const text = fromWork || fromTask;
    task.className = 'dsh-sess-task' + (text ? '' : ' empty');
    task.textContent = text || '（空闲）';
    main.appendChild(task);

    row.appendChild(main);
    return row;
  }

  /**
   * 点击一行：请求宿主记下"待打开会话"，由**已连在这个宿主上的页面**切过去。
   *
   * 两条通道，优先级不同：
   *   1) **轮询通道（主）**：POST /open-session 登记 → 页面侧插件每秒领取并调用
   *      `uiWorkspace.openSession` 切换。**不打开浏览器**，所以桌面版里点击就留在 App 内
   *      （DSH 桌面 App 只处理 `dsh://open`，没有会话级深链 —— 这是唯一"留在 App 内"的办法）。
   *   2) **深链（兜底，仅当没有已连接的页面时）**：打开 `?session=<id>`，页面加载时读参数切过去。
   *      什么时候需要它：宿主在跑但没有页面连着（App 窗口没开、或纯 CLI 场景）。
   *
   * 判定"页面在不在"：宿主在 POST 响应里回 `hasPage`（它知道有没有页面轮询过）。
   * 有页面 → 只走通道 1，不打扰浏览器；没有 → 才用深链把页面带起来。
   */
  async openSession(id, row) {
    row.classList.add('opening');
    let hasPage = false;
    try {
      const res = await fetch(BASE + '/open-session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      hasPage = Boolean(data && data.hasPage);
    } catch {
      // 宿主不可达：忽略（不打断宠物本体）
    }
    if (!hasPage) {
      /**
       * 没有页面在轮询 —— 分两种环境处理，**不能一律开浏览器**：
       *
       * * **桌面 App**（`window.__dshPetIsDesktopApp`）：App 明明就在那儿，开浏览器只会跳出 App，
       *   而且裸地址还会撞上 token 闸门（"dsh web authentication required; reopen the URL printed
       *   by dsh web."）。所以这里只做一件事：**把 App 窗口带到前台**；待打开的会话仍留在宿主里，
       *   页面恢复轮询（窗口回到前台时渲染进程不再被节流）自然会领取并切换。
       *
       * * **CLI（`dsh web`）**：确实没有页面，用**已认证地址**（宿主下发的 `appUrl`）打开并直达该会话。
       *   裸 origin 在 CLI 上通常也能用，但用 appUrl 更稳（CLI 也可能启用 token）。
       */
      if (window.__dshPetIsDesktopApp) {
        if (window.petBridge && window.petBridge.focusDshApp) window.petBridge.focusDshApp();
      } else {
        try {
          const base = window.__dshPetAppUrl || new URL(CONFIG.configUrl).origin + '/';
          const url = new URL(base);
          url.searchParams.set('session', id);
          if (window.petBridge && window.petBridge.openDshSite) window.petBridge.openDshSite(url.toString());
        } catch {
          // configUrl 异常时只做跳转请求，不前置浏览器
        }
      }
    } else {
      /**
       * 有页面 → 会话会在 App 窗口内切过去，但**切换本身不会把窗口带到前台**：
       * App 最小化或在后台时用户看不到结果（实测：前台点击正常，后台/最小化时"没反应"）。
       * 所以这里补一次 `dsh://open`（App 只处理这一个自定义 URL 分支，内部是
       * restore() + show() + focus()）。
       *
       * 延迟 350ms：先让页面轮询把会话切过去，再抢焦点；否则可能出现"窗口抢到前台时
       * 会话还没切完"，观感上像闪了一下旧会话。失败静默（非桌面环境没有该 scheme）。
       */
      window.setTimeout(() => {
        if (window.petBridge && window.petBridge.focusDshApp) window.petBridge.focusDshApp();
      }, 350);
    }
    window.setTimeout(() => row.classList.remove('opening'), 800);
  }
}
