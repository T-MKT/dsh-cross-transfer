import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CrossTransferClient } from './CrossTransferClient.js'
import { ChatPanel } from './ChatPanel.js'
import { closeOtherPanels, registerPanelCloser } from './panelBridge.js'

/**
 * Props delivered by the `sidebar.footer.action` slot: the sidebar's column
 * state plus the registrant's injected `client`.
 */
interface ChatLauncherProps {
  wide: boolean
  client: CrossTransferClient
}

/**
 * 聊天面板更值得占满一些：比 Cross Transfer 更宽（920 vs 720）、更高（0.72 vs 0.60），
 * 因为它要同时容纳左栏房间列表和右栏会话。
 */
const PANEL_WIDTH = 920
const PANEL_HEIGHT_RATIO = 0.72
/**
 * 面板在 panelBridge 里的标识，与 `src/client/index.tsx` 注册 slot 条目用的 id 一致。
 * 与 Cross Transfer 的 `cross-transfer-panel` 分开，互斥判定才认得出谁是谁。
 */
const PANEL_OWNER_ID = 'cross-transfer-chat-panel'

interface PanelAnchor {
  left: number
  bottom: number
  width: number
  height: number
}

/**
 * 侧边栏底部的聊天入口，与 Cross Transfer 的 ⇄ 入口并列。
 *
 * 座位本身仍是单个紧凑触发器（侧边栏那一列会裁剪脚部区域，放不下整幅界面），
 * 点击后在一个 `position: fixed` 的悬浮窗里打开聊天。
 *
 * 聊天与跨设备传输各自独立开合：两个面板可以同时开着，互不把对方顶掉。
 */
export const ChatLauncher: React.FC<ChatLauncherProps> = ({ wide, client }) => {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [anchor, setAnchor] = useState<PanelAnchor>()
  // isConnected() 是快照；不订阅的话侧边栏小点会一直停在旧状态。
  const [connected, setConnected] = useState(() => client.isConnected())
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const sync = () => setConnected(client.isConnected())
    sync()
    const offConnected = client.on('connected', sync)
    const offDisconnected = client.on('disconnected', sync)
    return () => {
      offConnected()
      offDisconnected()
    }
  }, [client])

  // 注册「关掉我」，并在自己打开时请 Cross Transfer 让位：两个面板都锚在侧边栏
  // 脚部（同一个 position: fixed 位置），同时开会整块互相盖住，所以互斥。
  useEffect(() => registerPanelCloser(PANEL_OWNER_ID, () => setOpen(false)), [])
  useEffect(() => {
    if (open) closeOtherPanels(PANEL_OWNER_ID)
  }, [open])

  // 锚定到触发器；视口变化时重新摆放。
  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(PANEL_WIDTH, window.innerWidth - 16)
      setAnchor({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
        bottom: window.innerHeight - rect.top + 8,
        width,
        height: Math.round(window.innerHeight * PANEL_HEIGHT_RATIO)
      })
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  }, [open])

  // 面板打开时，点外部或按 Escape 关闭。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (panelRef.current?.contains(target) || rootRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div
      ref={rootRef}
      style={{
        position: 'relative',
        width: wide ? '100%' : 36,
        height: wide ? 42 : 36,
        flex: 'none',
        marginTop: wide ? 8 : 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: wide ? 'stretch' : 'center'
      }}
    >
      <button
        type="button"
        aria-label="聊天"
        aria-expanded={open}
        data-cross-transfer-chat-trigger=""
        onClick={() => setOpen(value => !value)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: wide ? 'calc(100% + 4px)' : 36,
          height: wide ? 42 : 36,
          margin: wide ? '0 -2px' : 0,
          padding: wide ? '0 10px 0 8px' : 0,
          border: 'none',
          borderRadius: wide ? 12 : 999,
          background: open || hovered ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
          color: 'var(--dsw-alias-label-primary, inherit)',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: wide ? 'flex-start' : 'center',
          gap: 8,
          fontFamily: 'inherit',
          fontSize: 14,
          overflow: 'hidden'
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 16, lineHeight: '20px', flex: 'none' }}>💬</span>
        {wide && (
          <>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: 'left',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              聊天
            </span>
            <span
              aria-hidden="true"
              title={connected ? '已连接' : '未连接'}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flex: 'none',
                background: connected ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'
              }}
            />
          </>
        )}
      </button>

      {open && anchor && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="聊天"
          data-cross-transfer-chat-panel=""
          style={{
            position: 'fixed',
            left: anchor.left,
            bottom: anchor.bottom,
            width: anchor.width,
            height: anchor.height,
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            background: 'var(--dsw-specific-menu, #fff)',
            border: '0.5px solid var(--dsw-alias-border-l2, #ddd)',
            borderRadius: 12,
            boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)'
          }}
        >
          <ChatPanel client={client} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
