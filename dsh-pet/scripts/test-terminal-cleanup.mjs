#!/usr/bin/env node
/**
 * 宿主终态清理的回归测试：证明"计时器必须可重排"。
 *
 * 背景（真实故障，用户报"宠物用久了卡在工作中不再更新"）：
 *   `scheduleTerminalCleanup` 原来是**一次性**的 —— `if (terminalTimers.has(id)) return;`，
 *   而且 `terminalTimers.delete(id)` 写在回调开头。于是：
 *     ① 会话到达终态 → 排一个 24h 计时器；
 *     ② 这 24h 内会话又跑起来（终态 → working）；
 *     ③ 计时器到点：`state` 已不是 success/error → **不删条目**；
 *     ④ 但计时器条目已被 delete，且 ① 的 early return 让**再也没有第二个计时器**；
 *   ⇒ 该会话被永久留在状态表里。若它停在 `working`（优先级 40，高于 success/result/thinking），
 *     就会永远压住其他所有会话的状态更新 —— 面板/宠物卡在"工作中"不动。
 *
 * 这个测试从 **lib/index.js 里抽出真实的 `scheduleTerminalCleanup` 源码**来跑（不复制公式），
 * 因此它能真正反映运行代码的修复状态。
 *
 * 用法：node scripts/test-terminal-cleanup.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = join(HERE, '..', 'lib', 'index.js');
const src = fs.readFileSync(HOST, 'utf8');

// ---- 从产物里抽出真实实现（连同它的注释一起，便于阅读失败信息）----
function extract(name) {
  const start = src.indexOf(`const ${name} = (`);
  if (start < 0) throw new Error(`在 ${HOST} 里找不到 ${name} 的定义`);
  // 从 const 起到该箭头函数结束（顶层缩进处的一行 `};`）
  const rest = src.slice(start);
  const end = rest.indexOf('\n\t};');
  if (end < 0) throw new Error(`${name} 的结束位置没找到`);
  return rest.slice(0, end + 4);
}

const KEEP_MS = (() => {
  const m = src.match(/const TERMINAL_KEEP_MS = ([^;]+);/);
  if (!m) throw new Error('找不到 TERMINAL_KEEP_MS');
  // 源码里是 24 * 60 * 60 * 1e3 这样的字面量表达式，直接求值
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]};`)();
})();

/** 每次用例重建一份最小宿主状态，并注入抽出来的真实函数 */
function makeHarness() {
  /** 可控时钟：测试里显式推进，避免同毫秒造成的判定抖动 */
  const clock = { now: 1_000_000_000_000 };
  const DateStub = { now: () => clock.now };
  const workStatusBySession = new Map();
  const turnFlags = new Map();
  const terminalTimers = new Map();
  let refreshes = 0;
  const refreshWorkStatus = () => { refreshes += 1; };

  const code = `
    ${extract('scheduleTerminalCleanup')}
    ${extract('dropSessionState')}
    return { scheduleTerminalCleanup, dropSessionState };
  `;
  // eslint-disable-next-line no-new-func
  const { scheduleTerminalCleanup, dropSessionState } = new Function(
    'workStatusBySession', 'turnFlags', 'terminalTimers', 'refreshWorkStatus', 'TERMINAL_KEEP_MS',
    'setTimeout', 'clearTimeout', 'Date',
    code,
  )(workStatusBySession, turnFlags, terminalTimers, refreshWorkStatus, KEEP_MS,
    fakeSetTimeout, fakeClearTimeout, DateStub);

  return {
    scheduleTerminalCleanup, dropSessionState,
    workStatusBySession, terminalTimers,
    refreshes: () => refreshes,
    timers: () => fakeTimers.filter((t) => !t.cleared),
    /**
     * 真实"已排定计时器数"必须以 terminalTimers 这个 Map 为准。
     * 之前用 `timers()`（活动数组）断言，而 fireAll 会把数组清空 → 断言恒为 0，
     * 于是旧实现也能"通过"（假阳性）。这个 bug 的本质就藏在那个 Map 里。
     */
    scheduled: () => terminalTimers.size,
    clock,
  };
}

// 受控时钟：手动触发到期
let fakeTimers = [];
function fakeSetTimeout(fn, ms) {
  const t = { fn, ms, cleared: false, id: fakeTimers.length };
  fakeTimers.push(t);
  return t;
}
function fakeClearTimeout(t) { if (t) t.cleared = true; }
function fireAll() {
  const due = fakeTimers.filter((t) => !t.cleared);
  fakeTimers = [];
  for (const t of due) t.fn();
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

console.log(`TERMINAL_KEEP_MS = ${KEEP_MS} ms (${(KEEP_MS / 3600000).toFixed(1)}h)\n`);

// ---- 用例 1：终态后不再活动 → 到期清理 ----
{
  fakeTimers = [];
  const h = makeHarness();
  h.workStatusBySession.set('s1', { state: 'success', updatedAt: h.clock.now });
  h.scheduleTerminalCleanup('s1');
  check('终态 + 无后续活动 → 排了一个计时器', h.timers().length === 1);
  fireAll();
  check('到期后条目被清理', !h.workStatusBySession.has('s1'));
}

// ---- 用例 2（本 bug 的核心）：终态后又活动，之后应能再次被清理 ----
{
  fakeTimers = [];
  const h = makeHarness();
  h.workStatusBySession.set('s2', { state: 'success', updatedAt: h.clock.now });
  h.scheduleTerminalCleanup('s2');
  // 24h 内会话又跑起来（显式推进时钟，模拟"之后"有更新）
  h.clock.now += 60_000;
  h.workStatusBySession.set('s2', { state: 'working', updatedAt: h.clock.now });
  fireAll();
  check('期间又活动 → 第一次到期不清理（正确，它还在工作）', h.workStatusBySession.has('s2'));

  // 再次到达终态 → 必须能排**第二个**计时器（旧实现排不出来 = 永久泄漏）
  h.clock.now += 60_000;
  h.workStatusBySession.set('s2', { state: 'success', updatedAt: h.clock.now });
  h.scheduleTerminalCleanup('s2');
  check('再次到达终态 → 重新排了计时器（旧实现此处为 0）', h.scheduled() === 1,
    `scheduled=${h.scheduled()}`);
  fireAll();
  check('最终被清理（旧实现会永久残留）', !h.workStatusBySession.has('s2'));
}

// ---- 用例 2b（直击本质）：非终态到期后，后续终态必须还能被清理 ----
{
  fakeTimers = [];
  const h = makeHarness();
  h.workStatusBySession.set('s2b', { state: 'success', updatedAt: h.clock.now });
  h.scheduleTerminalCleanup('s2b');
  check('2b. 首次排定', h.scheduled() === 1);
  h.clock.now += 60_000;
  h.workStatusBySession.set('s2b', { state: 'working', updatedAt: h.clock.now });
  fireAll();
  check('2b. 非终态到期：不清理条目', h.workStatusBySession.has('s2b'));
  // 旧实现到这里 terminalTimers 已被 delete（回调开头）→ scheduled 为 0，
  // 后续虽然还能排新的，但**这次到期没有重新武装**，一旦之后再无终态事件，
  // 条目就永久留在表里占着最高优先级。
  h.clock.now += 60_000;
  h.workStatusBySession.set('s2b', { state: 'success', updatedAt: h.clock.now });
  h.scheduleTerminalCleanup('s2b');
  check('2b. 能再次武装', h.scheduled() === 1, `scheduled=${h.scheduled()}`);
  fireAll();
  check('2b. 最终清理干净', !h.workStatusBySession.has('s2b'));
}

// ---- 用例 3：重排时旧计时器必须被撤销（否则会被提前清掉）----
{
  fakeTimers = [];
  const h = makeHarness();
  h.workStatusBySession.set('s3', { state: 'success', updatedAt: h.clock.now });
  h.scheduleTerminalCleanup('s3');
  const first = h.timers()[0];
  h.scheduleTerminalCleanup('s3');
  check('重排后旧计时器被 clearTimeout', first.cleared === true);
  check('重排后只有一个活跃计时器', h.timers().length === 1);
}

// ---- 用例 4：会话销毁 → 立刻清理，不等 TTL ----
{
  fakeTimers = [];
  const h = makeHarness();
  h.workStatusBySession.set('s4', { state: 'working', updatedAt: h.clock.now });
  h.terminalTimers.set('s4', fakeSetTimeout(() => {}, KEEP_MS));
  h.dropSessionState('s4');
  check('dropSessionState 立刻删条目', !h.workStatusBySession.has('s4'));
  check('dropSessionState 顺手清掉计时器', h.timers().length === 0);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
