import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CrossTransferClient } from './CrossTransferClient.js'
import { CrossTransferUI } from './CrossTransferUI.js'

/**
 * Props delivered by the `sidebar.footer.action` slot: the sidebar's column
 * state plus the registrant's injected `client`.
 */
interface CrossTransferLauncherProps {
  wide: boolean
  client: CrossTransferClient
}

/** Preferred floating-panel width; clamped to the viewport when it is narrow. */
const PANEL_WIDTH = 720
/** Preferred floating-panel height share of the viewport. */
const PANEL_HEIGHT_RATIO = 0.6

interface PanelAnchor {
  left: number
  bottom: number
  width: number
  height: number
}

/**
 * Sidebar foot entry for cross-device transfer.
 *
 * The seat itself is a single compact trigger: the sidebar column clips its
 * foot area (`overflow: hidden`, 56px rail when collapsed), so a full-height
 * surface cannot live here. Clicking the trigger opens the transfer UI in a
 * `position: fixed` panel anchored above the trigger instead.
 */
export const CrossTransferLauncher: React.FC<CrossTransferLauncherProps> = ({ wide, client }) => {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [anchor, setAnchor] = useState<PanelAnchor>()
  const rootRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  // Anchor the panel to the trigger; re-place it when the viewport changes.
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

  // Dismiss on outside press or Escape while the panel is open.
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
        aria-label="Cross Transfer"
        aria-expanded={open}
        data-cross-transfer-trigger=""
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
        <span aria-hidden="true" style={{ fontSize: 16, lineHeight: '20px', flex: 'none' }}>⇄</span>
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
              Cross Transfer
            </span>
            <span
              aria-hidden="true"
              title={client.isConnected() ? 'Connected' : 'Disconnected'}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                flex: 'none',
                background: client.isConnected() ? '#28a745' : '#dc3545'
              }}
            />
          </>
        )}
      </button>

      {open && anchor && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Cross Transfer"
          data-cross-transfer-panel=""
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
          <CrossTransferUI client={client} />
        </div>
      )}
    </div>
  )
}
