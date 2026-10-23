import React, { useEffect, useRef, useState } from 'react'
import { CrossTransferClient, type ActiveRoom, type ChatMessage, type PeerDevice } from './CrossTransferClient.js'
import { openTransferPanel } from './panelBridge.js'

interface ChatPanelProps {
  client: CrossTransferClient
  /** 关闭这个独立聊天窗（由 ChatLauncher 传入）；不传就不显示关闭按钮。 */
  onClose?: () => void
}

/** 左栏房间列表的固定宽度。窗口本身宽 920px，会话区还剩约 700px。 */
const ROOM_LIST_WIDTH = 210

const timeStyle: React.CSSProperties = {
  fontSize: '11px',
  opacity: 0.65,
  marginTop: '4px',
  textAlign: 'right'
}

/** 消息类型 → 展示。system 走居中提示，file/code 各有专属渲染。 */
type MessageKind = ChatMessage['type']

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/** 只有跨天才插入分隔线，同一天内的消息不重复显示日期。 */
function formatDay(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString([], { month: '2-digit', day: '2-digit', weekday: 'short' })
}

function isSameDay(left: number, right: number): boolean {
  const a = new Date(left)
  const b = new Date(right)
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function formatSize(bytes: unknown): string {
  const value = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : NaN
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 文件消息的可读描述。
 *
 * 服务端的 file metadata 形状没有冻结（只有 Record<string, unknown>），
 * 所以逐键兜底：能读出名字/大小就显示，读不出来就只说「文件」，绝不渲染 undefined。
 */
function describeFile(metadata?: Record<string, unknown>): string {
  const name = metadata?.name ?? metadata?.fileName ?? metadata?.filename ?? metadata?.path
  const size = formatSize(metadata?.size ?? metadata?.bytes)
  const parts = [typeof name === 'string' && name.length > 0 ? name : '文件']
  if (size) parts.push(size)
  return parts.join(' · ')
}

/** 会话区里的单条消息。kind 决定外观：文本气泡 / 代码块 / 文件附件 / 系统提示。 */
const MessageBubble: React.FC<{ message: ChatMessage; own: boolean }> = ({ message, own }) => {
  if (message.type === 'system') {
    return (
      <div style={{ alignSelf: 'center', margin: '8px 0', padding: '2px 10px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>
        {message.content}
      </div>
    )
  }

  const kind: MessageKind = message.type
  const body =
    kind === 'code' ? (
      <pre
        style={{
          margin: 0,
          padding: '8px 10px',
          background: own ? 'rgba(0, 0, 0, 0.18)' : 'var(--dsw-alias-bg-layer-1)',
          borderRadius: 8,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
          fontSize: '12.5px',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          textAlign: 'left'
        }}
      >
        {message.content}
      </pre>
    ) : kind === 'file' ? (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span aria-hidden="true">📎</span>
        {describeFile(message.metadata)}
      </span>
    ) : (
      message.content
    )

  return (
    <div style={{ display: 'flex', justifyContent: own ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
      <div
        style={{
          maxWidth: '78%',
          padding: kind === 'code' ? '6px 6px' : '8px 12px',
          borderRadius: own ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
          background: own ? 'var(--dsw-alias-button-primary-fill)' : 'var(--dsw-alias-bg-layer-2)',
          color: own ? 'var(--dsw-alias-label-primary-inverted)' : 'var(--dsw-alias-label-primary)',
          boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)'
        }}
      >
        {!own && (
          <div style={{ fontSize: '12px', fontWeight: 600, opacity: 0.75, marginBottom: 2 }}>{message.senderDeviceName}</div>
        )}
        <div style={{ whiteSpace: kind === 'code' ? 'normal' : 'pre-wrap', wordBreak: 'break-word', fontSize: '14px', lineHeight: 1.5 }}>
          {body}
        </div>
        <div style={{ ...timeStyle, color: own ? 'inherit' : 'var(--dsw-alias-label-tertiary)' }}>
          {formatClock(message.timestamp)}
          {message.edited ? ' · 已编辑' : ''}
        </div>
      </div>
    </div>
  )
}

/**
 * 聊天模块的独立界面（§5.2 之外的独立入口，不再是 Cross Transfer 面板里的一个页签）。
 *
 * 左右两栏：左边是已加入的房间列表，右边是当前房间的会话。
 * 房间来源只有一个——客户端「已进入的房间」列表；没进房时只给引导，
 * 聊天输入与历史请求全部停摆（服务端也不会给未入房者任何房间消息）。
 */
export const ChatPanel: React.FC<ChatPanelProps> = ({ client, onClose }) => {
  const [joinedRooms, setJoinedRooms] = useState<ActiveRoom[]>([])
  const [currentRoom, setCurrentRoom] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [participants, setParticipants] = useState<PeerDevice[]>([])
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set())
  const [connected, setConnected] = useState(() => client.isConnected())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 房间集合与「当前房间」都由客户端事件驱动，组件不再自己发明房间。
  // 当前房间跟随客户端的 active room：切房间只是 setActiveRoom，不该在组件里再存一份副本。
  useEffect(() => {
    const sync = () => {
      const rooms = client.getJoinedRooms()
      setJoinedRooms(rooms)
      const active = client.getActiveRoom()?.roomId
      setCurrentRoom(prev => {
        if (active && rooms.some(room => room.roomId === active)) return active
        if (prev && rooms.some(room => room.roomId === prev)) return prev
        return rooms[0]?.roomId ?? ''
      })
    }

    client.on('roomJoined', sync)
    client.on('roomLeft', sync)
    client.on('activeRoomChanged', sync)
    sync()

    return () => {
      client.off('roomJoined', sync)
      client.off('roomLeft', sync)
      client.off('activeRoomChanged', sync)
    }
  }, [client])

  // 连接位是快照，不订阅就永远是旧值。
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

  // 消息与成员：全部针对当前已授权房间；没有房间时不订阅、不请求。
  useEffect(() => {
    if (!currentRoom) {
      setMessages([])
      setParticipants([])
      return
    }

    const handleChatMessage = (message: ChatMessage) => {
      if (message.roomId !== currentRoom) return
      setMessages(prev => [...prev, message])
    }

    const handleChatHistory = (history: ChatMessage[]) => {
      setMessages(history)
    }

    const handleUserJoined = (roomId: string, deviceId: string, deviceName: string) => {
      // 服务端已经不会再把自己推给自己；这里再挡一次，避免自己在成员列表里出现。
      if (roomId !== currentRoom || deviceId === client.getDeviceId()) return
      setParticipants(prev => [...prev.filter(p => p.deviceId !== deviceId), { deviceId, deviceName, sessionCount: 1, capabilities: [] }])
    }

    const handleUserLeft = (roomId: string, deviceId: string) => {
      if (roomId !== currentRoom) return
      setParticipants(prev => prev.filter(p => p.deviceId !== deviceId))
    }

    const handleTyping = (roomId: string, deviceId: string, deviceName: string, isTyping: boolean) => {
      if (roomId !== currentRoom) return

      setTypingUsers(prev => {
        const next = new Set(prev)
        if (isTyping) {
          next.add(`${deviceId}:${deviceName}`)
        } else {
          next.delete(`${deviceId}:${deviceName}`)
        }
        return next
      })

      // 3 秒没有新动静就自动清掉，免得对方的 typing 停在半路。
      if (isTyping) {
        const existing = typingTimeoutRef.current.get(deviceId)
        if (existing) clearTimeout(existing)
        const timeout = setTimeout(() => {
          setTypingUsers(prev => {
            const next = new Set(prev)
            next.delete(`${deviceId}:${deviceName}`)
            return next
          })
          typingTimeoutRef.current.delete(deviceId)
        }, 3000)
        typingTimeoutRef.current.set(deviceId, timeout)
      }
    }

    client.on('chatMessage', handleChatMessage)
    client.on('chatHistory', handleChatHistory)
    client.on('chatUserJoined', handleUserJoined)
    client.on('chatUserLeft', handleUserLeft)
    client.on('chatTyping', handleTyping)

    setMessages([])
    setParticipants([])
    client.requestChatHistory(currentRoom)

    return () => {
      client.off('chatMessage', handleChatMessage)
      client.off('chatHistory', handleChatHistory)
      client.off('chatUserJoined', handleUserJoined)
      client.off('chatUserLeft', handleUserLeft)
      client.off('chatTyping', handleTyping)
      typingTimeoutRef.current.forEach(t => clearTimeout(t))
      typingTimeoutRef.current.clear()
    }
  }, [client, currentRoom])

  // 新消息滚到底部；首次加载历史时也滚一次，否则会停在顶部。
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = () => {
    if (!currentRoom || !newMessage.trim()) return
    // 发送失败的错误走客户端的 error 事件；输入框内容保留给用户重试。
    client.sendChatMessage(currentRoom, newMessage.trim()).catch(() => {})
    setNewMessage('')
    client.setTyping(currentRoom, false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleComposerChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNewMessage(e.target.value)
    if (currentRoom) client.setTyping(currentRoom, true)
  }

  const isOwnMessage = (msg: ChatMessage) => msg.senderDeviceId === client.getDeviceId()

  const currentRoomInfo = joinedRooms.find(room => room.roomId === currentRoom)
  const typingNames = Array.from(typingUsers).map(entry => entry.split(':')[1]).filter(Boolean)

  // 没进房：只给引导，聊天输入与历史请求全部停摆。
  if (joinedRooms.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--dsw-alias-bg-layer-1)', padding: 24, gap: 12, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0, fontSize: 16 }}>聊天</h3>
          {onClose && (
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, color: 'var(--dsw-alias-label-tertiary)' }}
            >
              ✕
            </button>
          )}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, color: 'var(--dsw-alias-label-secondary)' }}>
          <span aria-hidden="true" style={{ fontSize: 32 }}>💬</span>
          <p style={{ margin: 0, fontSize: 14, textAlign: 'center' }}>
            还没有进入任何房间。<br />聊天需要先创建或加入一个房间。
          </p>
          <button
            type="button"
            onClick={openTransferPanel}
            style={{
              padding: '8px 16px',
              background: 'var(--dsw-alias-button-primary-fill)',
              color: 'var(--dsw-alias-label-primary-inverted)',
              border: 'none',
              borderRadius: 8,
              cursor: 'pointer',
              fontSize: 13
            }}
          >
            打开 Cross Transfer 面板
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: 'var(--dsw-alias-bg-layer-1)' }}>
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          borderBottom: '1px solid var(--dsw-alias-border-l1)',
          background: 'var(--dsw-alias-bg-layer-2)',
          flex: 'none'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <strong style={{ fontSize: 15, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {currentRoomInfo?.name || '(未命名房间)'}
          </strong>
          <span style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', flex: 'none' }}>{currentRoomInfo?.roomId}</span>
          {currentRoomInfo?.role === 'owner' && (
            <span style={{ fontSize: 11, padding: '1px 6px', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-secondary)', flex: 'none' }}>
              房主
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 'none' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}>
            <span
              aria-hidden="true"
              title={connected ? '已连接' : '未连接'}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: connected ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)'
              }}
            />
            {participants.length > 0 ? `${participants.length + 1} 人在线` : '仅自己在线'}
          </div>
          {onClose && (
            <button
              type="button"
              aria-label="关闭"
              onClick={onClose}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 15, color: 'var(--dsw-alias-label-tertiary)' }}
            >
              ✕
            </button>
          )}
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* 左栏：已加入的房间。点击即切换当前房间，不隐式 join/leave。 */}
        <nav
          aria-label="房间列表"
          style={{
            width: ROOM_LIST_WIDTH,
            flex: 'none',
            borderRight: '1px solid var(--dsw-alias-border-l1)',
            overflowY: 'auto',
            background: 'var(--dsw-alias-bg-layer-2)'
          }}
        >
          <div style={{ padding: '8px 10px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>房间</div>
          {joinedRooms.map(room => {
            const active = room.roomId === currentRoom
            return (
              <button
                key={room.roomId}
                type="button"
                onClick={() => client.setActiveRoom(room.roomId)}
                aria-current={active || undefined}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '8px 10px',
                  border: 'none',
                  borderLeft: active ? '2px solid var(--dsw-alias-state-business-primary)' : '2px solid transparent',
                  background: active ? 'var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12))' : 'transparent',
                  cursor: 'pointer',
                  color: 'var(--dsw-alias-label-primary)'
                }}
              >
                <div style={{ fontSize: 13, fontWeight: active ? 600 : 400, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {room.name || '(未命名房间)'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--dsw-alias-label-tertiary)', marginTop: 2 }}>
                  {room.roomId}{room.role === 'owner' ? ' · 房主' : ''}
                </div>
              </button>
            )
          })}
        </nav>

        {/* 右栏：会话 */}
        <section style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {typingNames.length > 0 && (
            <div style={{ padding: '4px 14px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', borderBottom: '1px solid var(--dsw-alias-border-l1)' }}>
              {typingNames.join('、')} 正在输入…
            </div>
          )}

          <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px', display: 'flex', flexDirection: 'column' }}>
            {messages.length === 0 ? (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 }}>
                还没有消息，说点什么吧。
              </div>
            ) : (
              messages.map((msg, index) => {
                const previous = messages[index - 1]
                const showDay = !previous || !isSameDay(previous.timestamp, msg.timestamp)
                return (
                  <React.Fragment key={msg.messageId}>
                    {showDay && (
                      <div style={{ alignSelf: 'center', margin: '10px 0', fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
                        {formatDay(msg.timestamp)}
                      </div>
                    )}
                    <MessageBubble message={msg} own={isOwnMessage(msg)} />
                  </React.Fragment>
                )
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <footer style={{ padding: '10px 12px', borderTop: '1px solid var(--dsw-alias-border-l1)', background: 'var(--dsw-alias-bg-layer-2)', flex: 'none' }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <textarea
                value={newMessage}
                onChange={handleComposerChange}
                onKeyDown={handleKeyDown}
                placeholder={connected ? '输入消息…' : '未连接，暂时无法发送'}
                disabled={!connected}
                rows={1}
                style={{
                  flex: 1,
                  minHeight: 40,
                  maxHeight: 140,
                  padding: '10px 12px',
                  border: '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: 10,
                  resize: 'none',
                  fontFamily: 'inherit',
                  fontSize: 14,
                  lineHeight: 1.5,
                  background: 'var(--dsw-alias-bg-layer-1)',
                  color: 'var(--dsw-alias-label-primary)'
                }}
              />
              <button
                type="button"
                onClick={handleSend}
                disabled={!connected || !newMessage.trim()}
                style={{
                  padding: '10px 18px',
                  background: 'var(--dsw-alias-button-primary-fill)',
                  color: 'var(--dsw-alias-label-primary-inverted)',
                  border: 'none',
                  borderRadius: 10,
                  cursor: connected && newMessage.trim() ? 'pointer' : 'not-allowed',
                  opacity: connected && newMessage.trim() ? 1 : 0.5,
                  fontSize: 14,
                  flex: 'none'
                }}
              >
                发送
              </button>
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--dsw-alias-label-tertiary)' }}>
              Enter 发送 · Shift+Enter 换行
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}
