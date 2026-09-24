#!/usr/bin/env node
/**
 * ⟲ 恢复功能的回归测试：**一次恢复一条（后进先出）**。
 *
 * 为什么是这个语义（用户反馈）：
 *   - 行不会自己消失（终态在 /sessions 里保留 24h），所以点 × 一定是主动行为；
 *   - 于是 ⟲ 的存在理由只剩"误关要能反悔"，而这只需要**最近那一条**；
 *   - 原先"一次全恢复"会把你之前每次"我确实不想看这条"的决定一起推翻 ——
 *     只想救回刚误关的那条，却得把其余几条重新关一遍。
 *
 * 另外验证两个容易漏的点：
 *   - 会话结束后它从 /sessions 消失 → 那条关闭记录已无从恢复，不该再让按钮亮着
 *     （否则点一下什么都不发生，用户会以为按钮坏了）；
 *   - 恢复顺序必须是**后进先出**（最近关掉的先回来），不是关掉顺序的倒序之外的任意顺序。
 *
 * 用法：node scripts/test-restore-lifo.mjs
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = join(HERE, '..', 'runtime', 'electron-helper', 'sessions-panel.js');
const src = fs.readFileSync(PANEL_SRC, 'utf8');

// 从真实实现里抽出两个方法（不复制公式）
function extractMethod(name) {
  const start = src.indexOf(`  ${name}(`);
  if (start < 0) throw new Error(`找不到方法 ${name}`);
  const rest = src.slice(start);
  const end = rest.indexOf('\n  }\n');
  if (end < 0) throw new Error(`方法 ${name} 的结尾没找到`);
  return rest.slice(0, end + 4);
}

/**
 * 抽出来的是**类方法**（`name(args) { ... }`，没有 function 关键字），
 * 直接拼进函数体会语法错误 —— 加回 `function` 变成函数声明。
 */
function toFunctionDeclaration(methodText) {
  return methodText.replace(/^\s*([A-Za-z_$][\w$]*)\s*\(/, 'function $1(');
}

const methods = ['restorableDismissals', 'restoreLastDismissed']
  .map(extractMethod)
  .map(toFunctionDeclaration)
  .join('\n');

/**
 * 用最小对象跑真实方法。
 * `restoreLastDismissed` 里会调 `this.render()`，桩成计数器即可。
 */
function makePanel(rawSessions) {
  let renders = 0;
  const panel = {
    rawSessions,
    dismissed: {},
    render() { renders += 1; },
  };
  // 挂回 panel 上：方法内部会互相调用（restoreLastDismissed → this.restorableDismissals），
  // 只 bind 返回的对象是不够的。
  const bind = new Function('panel', `
    ${methods}
    panel.restorableDismissals = restorableDismissals;
    panel.restoreLastDismissed = restoreLastDismissed;
    return panel;
  `);
  const api = bind(panel);
  return { panel, api, renders: () => renders };
}

const sess = (id, project) => ({ id, project, state: 'working', workText: 'x' });

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures += 1;
};

// ---- 用例 1：一次只恢复一条 ----
{
  const sessions = [sess('a', 'A'), sess('b', 'B'), sess('c', 'C')];
  const { panel, api } = makePanel(sessions);
  panel.dismissed = { a: { ts: 100 }, b: { ts: 200 }, c: { ts: 300 } };

  const first = api.restoreLastDismissed();
  check('第一次恢复 → 返回最近关的那条', first?.id === 'c', `得到 ${first?.id}`);
  check('其余两条仍在关闭名单里', Object.keys(panel.dismissed).sort().join(',') === 'a,b',
    Object.keys(panel.dismissed).join(','));
}

// ---- 用例 2：连续点 → 后进先出，直到清空 ----
{
  const sessions = [sess('a', 'A'), sess('b', 'B'), sess('c', 'C')];
  const { panel, api } = makePanel(sessions);
  panel.dismissed = { a: { ts: 100 }, b: { ts: 200 }, c: { ts: 300 } };
  const order = [];
  for (let i = 0; i < 4; i += 1) {
    const r = api.restoreLastDismissed();
    order.push(r === null ? 'null' : r.id);
  }
  check('后进先出顺序正确', order.join('>') === 'c>b>a>null', order.join('>'));
  check('全部恢复后名单为空', Object.keys(panel.dismissed).length === 0);
}

// ---- 用例 3：会话已从 /sessions 消失 → 那条记录不可恢复，且不应阻塞其他 ----
{
  // 'gone' 已被关闭，但宿主列表里已经没有它了（会话结束）
  const sessions = [sess('alive', 'ALIVE')];
  const { panel, api } = makePanel(sessions);
  panel.dismissed = { gone: { ts: 500 }, alive: { ts: 100 } };

  const n = api.restorableDismissals().length;
  check('不可恢复的记录不计入可恢复数', n === 1, `可恢复=${n}（gone 不该算）`);

  const r = api.restoreLastDismissed();
  check('恢复的是唯一可恢复的那条', r?.id === 'alive', `得到 ${r?.id}`);
  check('已消失会话的记录仍在名单里但不再可恢复', api.restorableDismissals().length === 0);
}

// ---- 用例 4：没有可恢复项 → 返回 null（按钮据此置灰）----
{
  const { api } = makePanel([sess('a', 'A')]);
  check('无可恢复项时返回 null', api.restoreLastDismissed() === null);
}

// ---- 用例 5：只关了一部分时，未被关的行不受影响 ----
{
  const sessions = [sess('a', 'A'), sess('b', 'B')];
  const { panel, api } = makePanel(sessions);
  panel.dismissed = { a: { ts: 100 } };
  const r = api.restoreLastDismissed();
  check('恢复被关的那条', r?.id === 'a');
  check('恢复后名单为空（b 本来就没关）', Object.keys(panel.dismissed).length === 0);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
