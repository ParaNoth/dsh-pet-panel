/**
 * 「会话面板」设置卡片 —— 注入到 dsh-pet 客户端 bundle 的 apply 体内。
 *
 * 为什么是这张卡片出现在 **设置页 → Plugins → Plugin configuration** 里：
 *   该标签页渲染的是「宿主注册了 settings 命名空间的插件」×「浏览器注册了同 key 卡片的插件」
 *   的交集，key = 命名空间名。宿主侧在 lib/index.js 里注册了 `dsh-pet` 命名空间
 *   （installSection），浏览器侧在这里注册同 key 的卡片，两者就配上了。
 *
 * 为什么不改宠物自己的「宠物配置」分区：那是上游组件，本仓库的 lib/client.js 是**在上游
 * 产物上做源码注入**得到的（上游 npm 包不带构建配置，无法重新构建）。往上游组件的 JSX 里塞
 * 控件要改它的 props 结构，脆得多；而新卡片是独立分支，只依赖公开的 slot/scope 契约。
 *
 * 读写的三条规矩（照抄 dsh-client-ui-settings-plugins 里卡的片做法）：
 *   1. 读：`ctx.settingsScope.bind({namespace})` 的 getSnapshot()，配合 subscribe 重渲染；
 *      status 为 'loading' 时显示"正在加载"，'unavailable' 时说明宿主没提供该命名空间，
 *      绝不静默显示成默认值（否则用户会以为"设置没生效"）。
 *   2. 写：`scope.set(field, value)` —— 每次写都带命名空间 revision，被拒时 scope 自己
 *      重新读回宿主状态，所以这里不需要自己维护草稿与冲突。
 *   3. 订阅用 useState + useEffect：scope 的订阅是显式 disposer，不是 React 生态的 store。
 *
 * **h 的约定**：注入点的 `h` 是 `require("react/jsx-runtime").jsx`，它的第二个参数是
 * props 对象、**子节点必须放在 props.children 里**（不是 createElement 的第 3+ 个参数）。
 * 所以下面所有元素都写成 `h(type, { ...props, children: ... })`。
 *
 * 本文件由 scripts/inject-deeplink.py 读入并原样插入 client.js（顶层），**不要**直接 require。
 */

/** 面板设置命名空间：必须与宿主 lib/index.js 的 PET_SETTINGS_NS 一致（也是卡片的 slot key） */
const PANEL_SETTINGS_NS = 'dsh-pet';

/**
 * 生成卡片组件。
 *
 * @param rt - 运行时胶水：{ h, useState, useEffect, scope }
 * @returns React 组件
 */
function makePanelSettingsCard(rt) {
  const { h, useState, useEffect, scope } = rt;

  /** 行样式（不引外部样式表：卡片是注入产物，样式集中在这里最好维护） */
  const rowStyle = { display: 'flex', alignItems: 'center', gap: '10px', margin: '8px 0' };
  /**
   * 卡片外壳：上游的卡片用 CSS Module 的类名（`PluginCard_module_css_default.card`），
   * 那是 ui-settings-plugins 的私有类，跨插件 import 被 bundle 纯净性门禁禁止。
   * 所以这里用**等价的内联样式**自绘一层，视觉上跟同列表里的其他卡片一致。
   */
  const cardStyle = {
    listStyle: 'none',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '10px',
    background: 'var(--dsw-alias-bg-layer-1)',
    padding: '12px 14px',
    margin: '0 0 10px',
  };
  const titleStyle = { fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' };
  const descStyle = { fontSize: '12px', opacity: 0.7, marginTop: '2px' };

  return function PanelSettingsCard() {
    const [snap, setSnap] = useState(scope.getSnapshot());
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');

    useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), []);

    const value = snap && snap.value ? snap.value : {};
    const enabled = value.enabled !== false;

    /** 写一个字段；失败时把宿主的原话显示出来，不吞掉 */
    const write = (field, next) => {
      setBusy(true);
      setErr('');
      scope.set(field, next).then(
        () => setBusy(false),
        (error) => {
          setBusy(false);
          setErr(error && error.message ? String(error.message) : String(error));
        },
      );
    };

    if (snap && snap.status === 'loading') {
      return h('div', { children: '正在加载面板设置…' });
    }
    if (snap && snap.status === 'unavailable') {
      return h('div', {
        children: '宿主没有提供 dsh-pet 设置命名空间（未挂载 settings 服务），面板设置此时以 main-config.json 为准。',
      });
    }

    return h('li', {
      style: cardStyle,
      children: [
        h('div', {
          key: 'head',
          children: [
            h('div', { key: 'title', style: titleStyle, children: 'DeepSeek Pet · 会话面板' }),
            h('div', {
              key: 'desc',
              style: descStyle,
              children: '宠物头顶那块会话列表的显示开关。保存立即生效，无需重启。',
            }),
          ],
        }),
        h('div', {
          key: 'enabled',
          style: rowStyle,
          children: [
            h('input', {
              key: 'box',
              type: 'checkbox',
              checked: enabled,
              disabled: busy,
              id: 'dsh-pet-panel-enabled',
              onChange: (event) => write('enabled', event.target.checked),
            }),
            h('label', { key: 'label', htmlFor: 'dsh-pet-panel-enabled', children: '显示会话面板' }),
          ],
        }),
        h('div', {
          key: 'position',
          style: { fontSize: '12px', opacity: 0.65, marginTop: '2px', lineHeight: 1.5 },
          children: '面板位置自动处理：默认居中于宠物；贴到屏幕边缘时整体平移收进来，不会被裁掉。',
        }),
        err
          ? h('div', {
              key: 'err',
              style: { color: 'var(--dsw-alias-state-error-primary, #d33)', fontSize: '12px' },
              children: '保存失败：' + err,
            })
          : null,
      ],
    });
  };
}
