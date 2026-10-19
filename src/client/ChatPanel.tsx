import React, { useState, useEffect, useRef } from 'react'
import { CrossTransferClient, type ActiveRoom, type ChatMessage, type PeerDevice } from './CrossTransferClient.js'

interface ChatPanelProps {
  client: CrossTransferClient
  /** 没进房时的引导去向：由 UI 外壳负责切页签，面板自己不碰标签状态。 */
  onRequireRooms?: () => void
}

/**
 * 聊天必须进房才能用。房间来源只有一个：客户端「已进入的房间」列表 ——
 * 旧实现自己维护房间数组并自动加入 `default`，服务端根本没有那些房间。
 */
export const ChatPanel: React.FC<ChatPanelProps> = ({ client, onRequireRooms }) => {
  const [joinedRooms, setJoinedRooms] = useState<ActiveRoom[]>([])
  const [currentRoom, setCurrentRoom] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [newMessage, setNewMessage] = useState('')
  const [participants, setParticipants] = useState<PeerDevice[]>([])
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set())
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const typingTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // 房间集合：由客户端事件驱动，组件不再自己发明房间。
  useEffect(() => {
    const sync = () => {
      const rooms = client.getJoinedRooms()
      setJoinedRooms(rooms)
      setCurrentRoom(prev => {
        if (prev && rooms.some(room => room.roomId === prev)) return prev
        return client.getActiveRoom()?.roomId ?? rooms[0]?.roomId ?? ''
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

      // Auto-clear typing after 3 seconds
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

  useEffect(() => {
    scrollToBottom()
  }, [messages])

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  const handleSend = () => {
    if (!currentRoom || !newMessage.trim()) return
    client.sendChatMessage(currentRoom, newMessage.trim()).catch(() => {
      // 发送失败的错误走客户端的 error 事件，输入框内容保留给用户重试。
    })
    setNewMessage('')
    client.setTyping(currentRoom, false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleTyping = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setNewMessage(e.target.value)
    if (currentRoom) client.setTyping(currentRoom, true)
  }

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }

  const isOwnMessage = (msg: ChatMessage) => msg.senderDeviceId === client.getDeviceId()

  // 没进房：只给引导，聊天输入与历史请求全部停摆。
  if (joinedRooms.length === 0) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff', padding: '24px', gap: '8px' }}>
        <h3 style={{ margin: 0 }}>Chat</h3>
        <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>
          还没有进入任何房间。聊天需要先创建或加入一个房间。
        </p>
        {onRequireRooms && (
          <button
            onClick={onRequireRooms}
            style={{ alignSelf: 'flex-start', padding: '6px 12px', background: '#007bff', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '13px' }}
          >
            去「Rooms」页签
          </button>
        )}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#fff' }}>
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <select
            value={currentRoom}
            onChange={(e) => {
              const roomId = e.target.value
              // 切换只是换「当前房间」；退出房间必须显式点退出，不再隐式 join/leave。
              client.setActiveRoom(roomId)
              setCurrentRoom(roomId)
              client.requestChatHistory(roomId)
            }}
            style={{ padding: '4px 8px' }}
          >
            {joinedRooms.map(room => (
              <option key={room.roomId} value={room.roomId}>
                {room.name || room.roomId} ({room.roomId}){room.role === 'owner' ? ' · 房主' : ''}
              </option>
            ))}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: '#666' }}>
          {participants.map(p => (
            <span key={p.deviceId} style={{ padding: '2px 6px', background: '#f0f0f0', borderRadius: '10px' }}>
              {p.deviceName}
            </span>
          ))}
        </div>
      </div>

      {typingUsers.size > 0 && (
        <div style={{ padding: '4px 16px', fontSize: '12px', color: '#666', borderBottom: '1px solid #eee' }}>
          {Array.from(typingUsers).map(t => t.split(':')[1]).join(', ')} typing...
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', padding: '16px', display: 'flex', flexDirection: 'column' }}>
        {messages.length === 0 ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999' }}>
            No messages yet. Start the conversation!
          </div>
        ) : (
          messages.map(msg => (
            <div
              key={msg.messageId}
              style={{
                display: 'flex',
                justifyContent: isOwnMessage(msg) ? 'flex-end' : 'flex-start',
                marginBottom: '12px'
              }}
            >
              <div
                style={{
                  maxWidth: '70%',
                  padding: '8px 12px',
                  borderRadius: isOwnMessage(msg) ? '18px 18px 0 18px' : '18px 18px 18px 0',
                  background: isOwnMessage(msg) ? '#007bff' : '#f0f0f0',
                  color: isOwnMessage(msg) ? '#fff' : '#333'
                }}
              >
                {!isOwnMessage(msg) && (
                  <p style={{ margin: '0 0 4px', fontSize: '12px', fontWeight: 500, opacity: 0.8 }}>
                    {msg.senderDeviceName}
                  </p>
                )}
                <p style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {msg.content}
                </p>
                <p style={{ margin: '4px 0 0', fontSize: '10px', opacity: 0.7, textAlign: 'right' }}>
                  {formatTime(msg.timestamp)}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <div style={{ padding: '12px 16px', borderTop: '1px solid #eee', display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
        <textarea
          value={newMessage}
          onChange={handleTyping}
          onKeyDown={handleKeyDown}
          placeholder="Type a message... (Shift+Enter for new line)"
          style={{
            flex: 1,
            minHeight: '44px',
            maxHeight: '120px',
            padding: '8px 12px',
            border: '1px solid #ddd',
            borderRadius: '20px',
            resize: 'none',
            fontFamily: 'inherit',
            fontSize: '14px',
            lineHeight: '1.5'
          }}
        />
        <button
          onClick={handleSend}
          disabled={!newMessage.trim()}
          style={{
            padding: '8px 16px',
            background: '#007bff',
            color: '#fff',
            border: 'none',
            borderRadius: '20px',
            cursor: newMessage.trim() ? 'pointer' : 'not-allowed',
            opacity: newMessage.trim() ? 1 : 0.5
          }}
        >
          Send
        </button>
      </div>
    </div>
  )
}
