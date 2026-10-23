/**
 * 悬浮面板之间的协调桥（ChatLauncher ↔ CrossTransferLauncher）。
 *
 * 侧边栏的 `sidebar.footer.action` 是列表插槽：Cross Transfer 与 Chat 各自注册一个
 * 条目，两个 React 树彼此独立，谁也拿不到对方的组件实例，各自的 `open` 状态更是
 * 组件内部状态。两条跨面板的诉求只能走这条模块级通道：
 *
 * 1. 聊天窗空状态需要一个「去创建/加入房间」的入口 → 打开 Cross Transfer 面板。
 * 2. 两个面板都锚在侧边栏脚部（`position: fixed` + 同一个触发器位置），
 *    同时开会整块互相盖住。让它们互斥：开一个就请另一个关掉。
 *
 * 它不持有任何聊天/房间状态，只保存「怎么操作另一个面板」这几个函数；
 * 谁挂载谁注册，卸载时按引用注销，因此同一时刻只有一份生效。
 */

/** 打开 Cross Transfer 面板的动作。 */
type TransferOpener = () => void

/** 关闭某个面板的动作。 */
type PanelCloser = () => void

let transferOpener: TransferOpener | null = null

/** 各面板的关闭动作，按注册时的 owner 标识索引。 */
const panelClosers = new Map<string, PanelCloser>()

/**
 * 由 CrossTransferLauncher 挂载时调用，返回注销函数。
 *
 * 传 null 表示「我没有面板可开」（未挂载/已卸载）。
 */
export function registerTransferOpener(opener: TransferOpener | null): () => void {
  transferOpener = opener
  return () => {
    if (transferOpener === opener) transferOpener = null
  }
}

/**
 * 由 ChatPanel 的空状态调用；对方没挂载时静默返回——宁可不响应，也不要抛。
 * （聊天窗先打开、Cross Transfer 还没挂载是常见时序。）
 */
export function openTransferPanel(): void {
  transferOpener?.()
}

/**
 * 由每个 launcher 挂载时调用，注册「关掉我」的动作，返回注销函数。
 *
 * `owner` 用 slot 条目的 id（`cross-transfer-panel` / `cross-transfer-chat-panel`），
 * 两个面板各占一个键，互不影响。
 */
export function registerPanelCloser(owner: string, closer: PanelCloser | null): () => void {
  if (closer) panelClosers.set(owner, closer)
  else panelClosers.delete(owner)
  return () => {
    if (panelClosers.get(owner) === closer) panelClosers.delete(owner)
  }
}

/** 关掉除 `except` 之外的所有面板。对方没挂载时自然无事发生。 */
export function closeOtherPanels(except: string): void {
  for (const [owner, closer] of Array.from(panelClosers)) {
    if (owner !== except) closer()
  }
}
