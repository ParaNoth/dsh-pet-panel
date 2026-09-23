#!/usr/bin/env node
/**
 * 几何回归测试：面板位置 = 「居中优先、越界平移」。
 *
 * 为什么必须存在这个文件：面板位置连续错了两轮，第二轮的原因是
 * **`AREAS` 元素用 `width`/`height`，而 `VIEW` 用 `w`/`h`** —— 代码读 `wa.w` 得到 undefined，
 * 边界算成 NaN，面板被摆到退化分支上（整块偏在窗口左边）。
 *
 * 更糟的是：当时的临时验证脚本**自己的桩**返回的正是 `{w, h}`，于是把真 bug 完美掩盖，
 * 连着两轮给出"居中偏移 0px ✅"的结论。**桩的数据形态必须与真实数据一致**，否则验证是负资产。
 *
 * 所以这个测试的两条硬约束：
 *   1. `AREAS` 一律用 `{x, y, width, height}`（真实 translateRects 的产物）；
 *   2. 直接 eval 真实的 `sessions-panel.js`，不复制公式 —— 复制公式就测不到实现里的 bug。
 *
 * 用法：node scripts/test-panel-geometry.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = join(HERE, '..', 'runtime', 'electron-helper', 'sessions-panel.js');

/** 面板自然宽度：与 index.html 的 `width: 180px` 保持一致 */
const PANEL_W = 180;
/** 每块屏的工作区（视口相对）。注意 width/height 命名 —— 这就是本文件存在的理由。 */
const DISPLAYS = [
  { x: 0, y: 25, width: 1512, height: 932 },
  { x: 1512, y: 25, width: 1512, height: 932 },
];

/** 被注入到 SessionsPanel 作用域里的那个 window（reposition 运行时会读它的 innerWidth） */
let PANEL_WINDOW = null;

/** 加载真实的 SessionsPanel 类（给最小可用的浏览器全局）。 */
function loadPanelClass() {
  const src = fs.readFileSync(PANEL_SRC, 'utf8');
  const win = {
    innerWidth: 360,
    devicePixelRatio: 2,
    addEventListener() {},
    setInterval: () => 0,
    setTimeout: () => 0,
    __dshPetInteractiveRegions: [],
  };
  const view = { x: 0, y: 0, w: 2 * 1512, h: 982 }; // VIEW 用 w/h（真实形态）
  const shared = {
    resolveRect: (areas, x, y) =>
      areas.find((a) => x >= a.x && x <= a.x + a.width && y >= a.y && y <= a.y + a.height) || areas[0],
  };
  const factory = new Function(
    'window',
    'AREAS',
    'VIEW',
    'S',
    'AbortSignal',
    `${src}\n; return SessionsPanel;`,
  );
  PANEL_WINDOW = win;
  return factory(win, DISPLAYS, view, shared, { timeout: () => undefined });
}

const SessionsPanel = loadPanelClass();

/** 跑一次真实 reposition()，返回它下发的变量与推算出的屏幕坐标。 */
function place(petX, size, winW) {
  const vars = {};
  PANEL_WINDOW.innerWidth = winW;
  const el = {
    hidden: false,
    style: { setProperty: (k, v) => (vars[k] = v) },
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: PANEL_W, height: 104 }),
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    textContent: '',
  };
  const panel = Object.create(SessionsPanel.prototype);
  panel.el = el;
  panel.diagEl = { textContent: '' };
  panel._posKey = null;
  panel.settings = { enabled: true };

  const margin = size * 0.5;
  panel.reposition({
    pos: { x: petX, y: 400 },
    size,
    margin: { l: margin, t: size * 0.25, r: margin, b: margin },
  });

  const winScreenL = petX - margin; // VIEW.x = 0
  const screenL = winScreenL + parseFloat(vars['--sess-panel-left']);
  return {
    diag: panel.diagEl.textContent,
    screenL,
    winScreenL,
    winW,
    left: vars['--sess-panel-left'],
    centerOffset: Math.round(screenL + PANEL_W / 2 - (petX + size / 2)),
    /** 面板完整可见 = 落在所有显示器工作区的并集内 */
    visibleWidth: Math.min(screenL + PANEL_W, Math.max(...DISPLAYS.map((a) => a.x + a.width))) - Math.max(screenL, Math.min(...DISPLAYS.map((a) => a.x))),
  };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

console.log('— 坐标系自检（本 bug 的根源）—');
{
  const r = place(666, 180, 360);
  check('诊断串里工作区宽度不是 NaN', !/NaN/.test(r.diag), r.diag);
  check('诊断串不含 BADGEOM', !/BADGEOM/.test(r.diag), r.diag);
}

console.log('\n— 居中优先 —');
for (const [name, petX, size, winW] of [
  ['宠物 180 / 窗口 360（缩放 0.5）', 666, 180, 360],
  ['宠物 240 / 窗口 480（无缩放）', 636, 240, 480],
  ['宠物 180 副屏居中', 2148, 180, 360],
]) {
  const r = place(petX, size, winW);
  check(name, r.centerOffset === 0, `偏移 ${r.centerOffset}px`);
}

console.log('\n— 越界时平移收进来（不是换边、不是收窄）—');
for (const [name, petX, size, winW] of [
  ['贴左缘', 0, 180, 360],
  ['贴右缘', 1332, 180, 360],
  ['贴主屏右缘', 1392, 180, 360],
]) {
  const r = place(petX, size, winW);
  check(name + ' 仍完整可见', Number.isFinite(r.visibleWidth) && r.visibleWidth >= PANEL_W - 1,
    `可见 ${Number.isFinite(r.visibleWidth) ? Math.round(r.visibleWidth) : 'NaN'}/${PANEL_W}px`);
}

console.log('\n— 全程扫描 —');
{
  const size = 180, winW = 360;
  let clipped = 0, centered = 0, total = 0, maxOff = 0;
  for (let x = -size * 0.25; x <= 3024 - size; x += 2) {
    const r = place(x, size, winW);
    total += 1;
    // 必须显式判有限性：NaN < x 恒为 false，只写 `r.visibleWidth < PANEL_W - 1` 会漏掉 NaN
    if (!Number.isFinite(r.visibleWidth) || r.visibleWidth < PANEL_W - 1) clipped += 1;
    if (r.centerOffset === 0) centered += 1;
    maxOff = Math.max(maxOff, Math.abs(r.centerOffset));
  }
  check(`${total} 个位置零裁剪（含 NaN 检查）`, clipped === 0, `异常 ${clipped} 处`);
  check('多数位置完全居中', centered / total > 0.85, `${((centered / total) * 100).toFixed(1)}% 居中，最大偏移 ${maxOff}px`);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
