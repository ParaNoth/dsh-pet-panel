// 会话跳转握手（页面侧）：面板点击某行 → 宿主记下「待打开会话」→ 本模块轮询领取 →
// 调客户端 sessions 服务切过去 → 用 nonce ack 让宿主清空（保证只跳一次）。
//
// 设计取舍：
//   - **无 UI、无提醒**：只在有人点了面板时才动作，平时静默；与 dsh-notify 那类提醒互不干扰。
//   - **轮询而不是事件流**：DSH 0.1.5 删除了浏览器侧 api.events.mux，页面能依赖的稳定通道
//     就是宿主插件路由（本包 /dsh-pet-7340/* 已证明可用）。
//   - **缓存必须打穿**：带 cache:'no-store' —— 否则浏览器缓存会把请求挡在宿主之外，
//     表现为「点了没反应」且毫无报错。
/** 轮询周期：面板点击是交互动作，1s 内的延迟可接受 */
const POLL_MS = 1000;
/** 请求超时：宿主重启中不能把页面卡住 */
const TIMEOUT_MS = 4000;
/** 端点（相对路径：页面与宿主同源，桌面渲染器里也走同一份路由） */
const ENDPOINT = '/dsh-pet-7340/open-session';

/** DSH 客户端会话服务的最小契约（面板只需要 open） */
interface SessionService {
  open(id: string): void;
}

/** 最小 ctx 契约：只需要 get 与 effect */
interface ClientCtx {
  get?: (name: string) => unknown;
  effect?: (callback: () => (() => void) | void, label?: string) => void;
}

type PendingReply = { sessionId?: unknown; nonce?: unknown };

/** 拉取一次待打开会话；返回 null 表示无请求或不可用（绝不抛错打断轮询） */
async function fetchPending(ack: string | null): Promise<{ id: string; nonce: string } | null> {
  try {
    const url = ack === null ? ENDPOINT : `${ENDPOINT}?ack=${encodeURIComponent(ack)}`;
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = (await res.json()) as PendingReply;
    const id = typeof data?.sessionId === 'string' ? data.sessionId : '';
    const nonce = typeof data?.nonce === 'string' ? data.nonce : '';
    return id !== '' && nonce !== '' ? { id, nonce } : null;
  } catch {
    return null; // 宿主不可达（重启中/未装新端点）：静默重试，不弹错
  }
}

/**
 * 启动会话跳转握手轮询。放在 ctx.effect 里，插件卸载即停（不留后台定时器）。
 * @param ctx - DSH 注入的客户端 ctx
 */
export function startSessionLink(ctx: ClientCtx): void {
  const sessions = ctx.get?.('sessions') as SessionService | undefined;
  if (sessions === undefined || typeof sessions.open !== 'function') {
    // 服务缺失：静默退出（本功能是可选增强，绝不影响宠物本体）
    return;
  }

  let stopped = false;
  const start = () => {
    if (stopped) return;
    void tick();
  };
  /** 上一次已领取但尚未确认的 nonce：确认前不重复导航，确认后不再重放 */
  let inFlight: { id: string; nonce: string } | null = null;

  const tick = async () => {
    if (stopped) return;
    // 先尝试确认上一次的导航（清空宿主侧待打开状态），再领取新的
    const ackOf = inFlight === null ? null : inFlight.nonce;
    const next = await fetchPending(ackOf);
    if (stopped) return;
    if (next === null) {
      inFlight = null; // 确认成功（或本就没有请求）
    } else if (inFlight === null || inFlight.nonce !== next.nonce) {
      inFlight = next;
      try {
        sessions.open(next.id);
      } catch (error) {
        console.warn('[dsh-pet] session-link: sessions.open failed:', error);
        inFlight = null; // 打开失败：不占用 nonce，允许下次重试
      }
    }
  };

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      const timer = window.setInterval(start, POLL_MS);
      start();
      return () => {
        stopped = true;
        window.clearInterval(timer);
      };
    }, 'dsh-pet: session-link');
    return;
  }
  // 无 effect 能力时的兜底：仍然轮询，但无法在卸载时清理（正常装配下不会走到这里）
  window.setInterval(start, POLL_MS);
  start();
}
