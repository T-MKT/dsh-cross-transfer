import { describe, it, expect, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ChatService } from '../src/chat.js'
import type { ChatMessage, ChatRoom } from '../src/chat.js'

type SendMessageArgs = Parameters<ChatService['sendMessage']>[0]

function createChat(config: Partial<ChatConfig> = {}): ChatService {
  const chat = new ChatService(new Context())
  chat.initialize(config)
  return chat
}

interface ChatConfig {
  maxHistoryPerRoom: number
  maxMessageLength: number
}

function send(chat: ChatService, overrides: Partial<SendMessageArgs> = {}): ChatMessage {
  return chat.sendMessage({
    roomId: 'default',
    senderDeviceId: 'device-1',
    senderDeviceName: 'Device One',
    senderSessionId: 'session-1',
    content: 'hello',
    ...overrides,
  })
}

describe('ChatService', () => {
  describe('initialize', () => {
    it('creates the default room automatically', () => {
      const chat = createChat()
      const room = chat.getRoom('default')
      expect(room).toBeDefined()
      expect(room!.roomId).toBe('default')
      expect(room!.name).toBe('General')
      expect(room!.participantCount).toBe(0)
    })

    it('only contains the default room right after initialize', () => {
      const chat = createChat()
      expect(chat.getRooms()).toHaveLength(1)
      expect(chat.getRooms()[0].roomId).toBe('default')
    })

    it('emits room-created for the default room during initialize', () => {
      const chat = new ChatService(new Context())
      const listener = vi.fn()
      chat.on('room-created', listener)
      chat.initialize()
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ roomId: 'default', name: 'General' }),
      )
    })
  })

  describe('createRoom', () => {
    it('creates a room successfully with expected fields', () => {
      const chat = createChat()
      const room = chat.createRoom('dev-chat', 'Device Chat')
      expect(room.roomId).toBe('dev-chat')
      expect(room.name).toBe('Device Chat')
      expect(typeof room.createdAt).toBe('number')
      expect(room.participantCount).toBe(0)
      expect(room.lastMessageAt).toBe(0)
      expect(chat.getRoom('dev-chat')).toEqual(room)
    })

    it('throws when the roomId already exists', () => {
      const chat = createChat()
      expect(() => chat.createRoom('default', 'Dup')).toThrow('Room already exists')
      // original room is untouched
      expect(chat.getRoom('default')!.name).toBe('General')
    })

    it('emits room-created with the created room', () => {
      const chat = createChat()
      const listener = vi.fn()
      chat.on('room-created', listener)
      const room = chat.createRoom('room-2', 'Second Room')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(room)
    })
  })

  describe('joinRoom', () => {
    it('joins successfully and updates participantCount', () => {
      const chat = createChat()
      const result = chat.joinRoom('device-1', 'Device One', 'default')
      expect(result).toBe(true)
      expect(chat.getRoom('default')!.participantCount).toBe(1)

      chat.joinRoom('device-2', 'Device Two', 'default')
      expect(chat.getRoom('default')!.participantCount).toBe(2)
    })

    it('joining the same device twice does not double-count participants', () => {
      const chat = createChat()
      expect(chat.joinRoom('device-1', 'Device One', 'default')).toBe(true)
      expect(chat.joinRoom('device-1', 'Device One', 'default')).toBe(true)
      expect(chat.getRoom('default')!.participantCount).toBe(1)
    })

    it('returns false when the room does not exist', () => {
      const chat = createChat()
      expect(chat.joinRoom('device-1', 'Device One', 'missing-room')).toBe(false)
    })

    it('emits user-joined with roomId, deviceId and deviceName', () => {
      const chat = createChat()
      const listener = vi.fn()
      chat.on('user-joined', listener)
      chat.joinRoom('device-1', 'Device One', 'default')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('default', 'device-1', 'Device One')
    })
  })

  describe('leaveRoom', () => {
    it('leaves successfully and updates participantCount', () => {
      const chat = createChat()
      chat.joinRoom('device-1', 'Device One', 'default')
      chat.joinRoom('device-2', 'Device Two', 'default')
      const result = chat.leaveRoom('device-1', 'Device One', 'default')
      expect(result).toBe(true)
      expect(chat.getRoom('default')!.participantCount).toBe(1)
      expect(chat.getParticipants('default')).toEqual(['device-2'])
    })

    it('returns false when the room does not exist', () => {
      const chat = createChat()
      expect(chat.leaveRoom('device-1', 'Device One', 'missing-room')).toBe(false)
    })

    it('emits user-left with roomId and deviceId', () => {
      const chat = createChat()
      chat.joinRoom('device-1', 'Device One', 'default')
      const listener = vi.fn()
      chat.on('user-left', listener)
      chat.leaveRoom('device-1', 'Device One', 'default')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('default', 'device-1')
    })
  })

  describe('sendMessage', () => {
    it('sends a message successfully with all sender fields', () => {
      const chat = createChat()
      const message = send(chat, { content: 'hello world' })
      expect(message.content).toBe('hello world')
      expect(message.roomId).toBe('default')
      expect(message.senderDeviceId).toBe('device-1')
      expect(message.senderDeviceName).toBe('Device One')
      expect(message.senderSessionId).toBe('session-1')
      expect(message.messageId).toMatch(/^msg_/)
      expect(typeof message.timestamp).toBe('number')
      expect(chat.getHistory('default')).toHaveLength(1)
    })

    it('throws when the room does not exist', () => {
      const chat = createChat()
      expect(() => send(chat, { roomId: 'missing-room' })).toThrow('Room not found')
    })

    it('throws when content exceeds maxMessageLength', () => {
      const chat = createChat({ maxMessageLength: 10 })
      expect(() => send(chat, { content: 'a'.repeat(11) })).toThrow('Message too long')
      expect(chat.getHistory('default')).toHaveLength(0)
    })

    it('accepts content of exactly maxMessageLength', () => {
      const chat = createChat({ maxMessageLength: 10 })
      const message = send(chat, { content: 'a'.repeat(10) })
      expect(message.content).toHaveLength(10)
    })

    it('defaults type to text', () => {
      const chat = createChat()
      const message = send(chat, { content: 'plain text' })
      expect(message.type).toBe('text')
    })

    it('keeps an explicitly provided type', () => {
      const chat = createChat()
      const message = send(chat, { content: 'file payload', type: 'file' })
      expect(message.type).toBe('file')
    })

    it('emits the message event with the sent message', () => {
      const chat = createChat()
      const listener = vi.fn()
      chat.on('message', listener)
      const message = send(chat, { content: 'event payload' })
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(message)
    })

    it('updates room lastMessageAt', () => {
      const chat = createChat()
      expect(chat.getRoom('default')!.lastMessageAt).toBe(0)
      const message = send(chat)
      expect(chat.getRoom('default')!.lastMessageAt).toBe(message.timestamp)
    })
  })

  describe('editMessage', () => {
    it('edits successfully and marks edited=true', () => {
      const chat = createChat()
      const message = send(chat, { content: 'before' })
      const edited = chat.editMessage(message.messageId, 'default', 'after', 'device-1')
      expect(edited).not.toBeNull()
      expect(edited!.content).toBe('after')
      expect(edited!.edited).toBe(true)
      expect(edited!.messageId).toBe(message.messageId)
      expect(chat.getHistory('default')[0].content).toBe('after')
      expect(chat.getHistory('default')[0].edited).toBe(true)
    })

    it('returns null when the message does not exist', () => {
      const chat = createChat()
      expect(chat.editMessage('no-such-msg', 'default', 'new', 'device-1')).toBeNull()
    })

    it('returns null when the room does not exist', () => {
      const chat = createChat()
      const message = send(chat)
      expect(chat.editMessage(message.messageId, 'missing-room', 'new', 'device-1')).toBeNull()
    })

    it('throws when the editor is not the sender', () => {
      const chat = createChat()
      const message = send(chat, { content: 'mine' })
      expect(() =>
        chat.editMessage(message.messageId, 'default', 'hijacked', 'device-2'),
      ).toThrow('Not authorized to edit this message')
      expect(chat.getHistory('default')[0].content).toBe('mine')
    })

    it('emits message-edited with the updated message', () => {
      const chat = createChat()
      const message = send(chat, { content: 'old' })
      const listener = vi.fn()
      chat.on('message-edited', listener)
      const edited = chat.editMessage(message.messageId, 'default', 'new', 'device-1')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(edited)
      expect(edited!.edited).toBe(true)
    })
  })

  describe('deleteMessage', () => {
    it('deletes successfully and removes it from history', () => {
      const chat = createChat()
      const keep = send(chat, { content: 'keep' })
      const gone = send(chat, { content: 'gone' })
      const result = chat.deleteMessage(gone.messageId, 'default', 'device-1')
      expect(result).toBe(true)
      const history = chat.getHistory('default')
      expect(history).toHaveLength(1)
      expect(history[0].messageId).toBe(keep.messageId)
    })

    it('returns false when the message does not exist', () => {
      const chat = createChat()
      expect(chat.deleteMessage('no-such-msg', 'default', 'device-1')).toBe(false)
    })

    it('returns false when the room does not exist', () => {
      const chat = createChat()
      const message = send(chat)
      expect(chat.deleteMessage(message.messageId, 'missing-room', 'device-1')).toBe(false)
    })

    it('throws when the deleter is not the sender', () => {
      const chat = createChat()
      const message = send(chat)
      expect(() => chat.deleteMessage(message.messageId, 'default', 'device-2')).toThrow(
        'Not authorized to delete this message',
      )
      expect(chat.getHistory('default')).toHaveLength(1)
    })

    it('emits message-deleted with messageId and roomId', () => {
      const chat = createChat()
      const message = send(chat)
      const listener = vi.fn()
      chat.on('message-deleted', listener)
      chat.deleteMessage(message.messageId, 'default', 'device-1')
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(message.messageId, 'default')
    })
  })

  describe('getHistory', () => {
    it('returns at most 100 messages by default', () => {
      const chat = createChat()
      for (let i = 0; i < 105; i++) {
        send(chat, { content: `msg-${i}` })
      }
      const history = chat.getHistory('default')
      expect(history).toHaveLength(100)
      expect(history[0].content).toBe('msg-5')
      expect(history[99].content).toBe('msg-104')
    })

    it('honors a specified limit and returns the newest messages', () => {
      const chat = createChat()
      for (let i = 0; i < 5; i++) {
        send(chat, { content: `msg-${i}` })
      }
      const history = chat.getHistory('default', 2)
      expect(history).toHaveLength(2)
      expect(history.map(m => m.content)).toEqual(['msg-3', 'msg-4'])
    })

    it('filters by before timestamp', () => {
      const chat = createChat()
      const m1 = send(chat, { content: 'one' })
      const m2 = send(chat, { content: 'two' })
      const m3 = send(chat, { content: 'three' })
      // stabilize timestamps (they may share the same millisecond)
      ;(m1 as any).timestamp = 1000
      ;(m2 as any).timestamp = 2000
      ;(m3 as any).timestamp = 3000

      const history = chat.getHistory('default', 100, 2500)
      expect(history.map(m => m.content)).toEqual(['one', 'two'])

      const none = chat.getHistory('default', 100, 1000)
      expect(none).toEqual([])

      const all = chat.getHistory('default', 100, 4000)
      expect(all.map(m => m.content)).toEqual(['one', 'two', 'three'])
    })

    it('returns an empty array for a nonexistent room', () => {
      const chat = createChat()
      expect(chat.getHistory('missing-room')).toEqual([])
      expect(chat.getHistory('missing-room', 10, 12345)).toEqual([])
    })
  })

  describe('getParticipants / getUserRooms', () => {
    it('getParticipants reflects current room membership', () => {
      const chat = createChat()
      chat.joinRoom('device-1', 'Device One', 'default')
      chat.joinRoom('device-2', 'Device Two', 'default')
      expect(chat.getParticipants('default').sort()).toEqual(['device-1', 'device-2'])
      chat.leaveRoom('device-1', 'Device One', 'default')
      expect(chat.getParticipants('default')).toEqual(['device-2'])
    })

    it('getParticipants returns [] for a nonexistent room', () => {
      const chat = createChat()
      expect(chat.getParticipants('missing-room')).toEqual([])
    })

    it('getUserRooms tracks rooms per device and empties after leaving all', () => {
      const chat = createChat()
      expect(chat.getUserRooms('device-1')).toEqual([])

      chat.createRoom('room-a', 'Room A')
      chat.joinRoom('device-1', 'Device One', 'default')
      chat.joinRoom('device-1', 'Device One', 'room-a')
      expect(chat.getUserRooms('device-1').sort()).toEqual(['default', 'room-a'])

      chat.leaveRoom('device-1', 'Device One', 'room-a')
      expect(chat.getUserRooms('device-1')).toEqual(['default'])

      chat.leaveRoom('device-1', 'Device One', 'default')
      expect(chat.getUserRooms('device-1')).toEqual([])
    })
  })

  describe('history trimming', () => {
    it('trims history to maxHistoryPerRoom', () => {
      const chat = createChat({ maxHistoryPerRoom: 3 })
      for (let i = 0; i < 5; i++) {
        send(chat, { content: `trim-${i}` })
      }
      const history = chat.getHistory('default')
      expect(history).toHaveLength(3)
      expect(history.map(m => m.content)).toEqual(['trim-2', 'trim-3', 'trim-4'])

      // internal storage is trimmed as well
      const internal = (chat as any).rooms.get('default') as {
        messages: ChatMessage[]
      }
      expect(internal.messages).toHaveLength(3)
    })

    it('does not trim while under the limit', () => {
      const chat = createChat({ maxHistoryPerRoom: 3 })
      send(chat, { content: 'a' })
      send(chat, { content: 'b' })
      expect(chat.getHistory('default')).toHaveLength(2)
    })
  })

  describe('shutdown', () => {
    it('clears all rooms so getRooms is empty', () => {
      const chat = createChat()
      chat.createRoom('extra', 'Extra')
      expect(chat.getRooms().length).toBeGreaterThan(0)

      chat.shutdown()
      expect(chat.getRooms()).toEqual([])
      expect(chat.getRoom('default')).toBeUndefined()
      expect(chat.getHistory('default')).toEqual([])
    })

    it('clears user room membership as well', () => {
      const chat = createChat()
      chat.joinRoom('device-1', 'Device One', 'default')
      expect(chat.getUserRooms('device-1')).toEqual(['default'])
      chat.shutdown()
      expect(chat.getUserRooms('device-1')).toEqual([])
    })
  })
})
