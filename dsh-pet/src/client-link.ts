// client 半侧的**包装入口**（替代 lib/client.js 成为 dsh.client 的入口）。
//
// 为什么要有这个文件：本包的源码里没有随包发布构建配置（tsdown.config / tsconfig 都不在
// tarball 里），所以无法用原流水线重建 lib/client.js。这个包装层避免改动原 bundle 一个字节：
//   1. 先加载原 bundle（它会调用 window.__ModuleLoader__.load 注册 id="dsh-pet"）；
//   2. 用 pendingQueue 里那份注册数据，包装它的 factory —— 在原插件 apply 之外，
//      额外启动「会话跳转握手」轮询（页面侧静默监听，无 UI）；
//   3. 用新 factory 重新注册同一 id（模块表按 id 覆盖，等于替换）。
//
// 副作用：本文件同样必须是「普通副作用脚本」（无顶层 export/import），由 tsdown 或
// 直接 copy 到 lib/ 均可；模块加载器只要求它调用 __ModuleLoader__.load。
/* eslint-disable @typescript-eslint/no-explicit-any -- DSH 全局注入的模块系统与 ctx 均无静态类型 */
import { startSessionLink } from '../runtime/client/session-link.js';

declare const window: {
  __ModuleLoader__: {
    load(info: { id: string; factory: (require: (m: string) => any) => any }): void;
    pendingQueue?: Array<{ id: string; factory: (require: (m: string) => any) => any }>;
  };
};

const MODULE_ID = 'dsh-pet';

/** 从模块加载器的待处理队列里取出原注册项（必须在加载原 bundle 之后读）。 */
function takeBaseRegistration(loader: typeof window.__ModuleLoader__) {
  const queue = Array.isArray(loader.pendingQueue) ? loader.pendingQueue : [];
  const found = queue.find((entry) => entry && entry.id === MODULE_ID);
  if (found) queue.splice(queue.indexOf(found), 1); // 移除原注册，避免重复注册同一 id
  return found;
}

const loader = window.__ModuleLoader__;
const base = takeBaseRegistration(loader);

if (base === undefined) {
  // 原 bundle 未注册（加载顺序异常）：退回原样加载，不阻断页面
  console.warn('[dsh-pet] client-link: base registration not found; loading plain bundle');
} else {
  loader.load({
    id: MODULE_ID,
    factory: (require: (m: string) => any) => {
      const plugin = base.factory(require);
      const baseApply = plugin && typeof plugin.apply === 'function' ? plugin.apply : undefined;
      if (baseApply === undefined) return plugin;
      return {
        ...plugin,
        apply(ctx: any) {
          const result = baseApply.call(plugin, ctx);
          // 页面侧会话跳转握手：无 UI、无提醒，只在面板点了某一行时切会话
          try {
            startSessionLink(ctx);
          } catch (error) {
            console.warn('[dsh-pet] session-link failed to start:', error);
          }
          return result;
        },
      };
    },
  });
}
