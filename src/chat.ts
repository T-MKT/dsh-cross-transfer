import { Service, Context } from '@deepseek-ai/cordis'
import { createTypedEmitter, TypedEmitter } from './typed-emitter.js'

export interface ChatConfig {
  maxHistoryPerRoom: number
  maxMessageLength: number
}

export interface ChatMessage {
  messageId: string
  roomId: string
  senderDeviceId: string
  senderDeviceName: string
  senderSessionId: string
  content: string
  type: 'text' | 'system' | 'file' | 'code'
  metadata?: Record<string, unknown>
  timestamp: number
  edited?: boolean
  replyTo?: string
}

export interface ChatRoom {
  roomId: string
  name: string
  createdAt: number
  participantCount: number
  lastMessageAt: number
}

export interface ChatEvents {
  'message': [message: ChatMessage]
  'message-edited': [message: ChatMessage]
  'message-deleted': [messageId: string, roomId: string]
  'room-created': [room: ChatRoom]
  'user-joined': [roomId: string, deviceId: string, deviceName: string]
  'user-left': [roomId: string, deviceId: string]
  'typing': [roomId: string, deviceId: string, deviceName: string, isTyping: boolean]
}

export class ChatService extends Service {
  private config: ChatConfig | null = null
  private rooms = new Map<string, { info: ChatRoom; participants: Set<string>; messages: ChatMessage[] }>()
  private userRooms = new Map<string, Set<string>>() // deviceId -> roomIds
  private emitter = createTypedEmitter<ChatEvents>()

  constructor(ctx: Context) {
    super(ctx, 'chat')
  }

  // TypedEmitter methods
  on<K extends keyof ChatEvents>(event: K, listener: (...args: ChatEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof ChatEvents>(event: K, listener: (...args: ChatEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof ChatEvents>(event: K, ...args: ChatEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof ChatEvents>(event: K, listener: (...args: ChatEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  initialize(config: Partial<ChatConfig> = {}): void {
    this.config = {
      maxHistoryPerRoom: config.maxHistoryPerRoom || 1000,
      maxMessageLength: config.maxMessageLength || 10000
    }

    // Create default room
    this.createRoom('default', 'General')

    this.ctx.logger.info('[cross-transfer] Chat service initialized')
  }

  createRoom(roomId: string, name: string): ChatRoom {
    if (this.rooms.has(roomId)) {
      throw new Error('Room already exists')
    }

    const room: ChatRoom = {
      roomId,
      name,
      createdAt: Date.now(),
      participantCount: 0,
      lastMessageAt: 0
    }

    this.rooms.set(roomId, {
      info: room,
      participants: new Set(),
      messages: []
    })

    this.emit('room-created', room)
    this.ctx.logger.info(`[cross-transfer] Chat room created: ${name} (${roomId})`)

    return room
  }

  getRoom(roomId: string): ChatRoom | undefined {
    return this.rooms.get(roomId)?.info
  }

  getRooms(): ChatRoom[] {
    return Array.from(this.rooms.values()).map(r => r.info)
  }

  joinRoom(deviceId: string, deviceName: string, roomId: string = 'default'): boolean {
    const room = this.rooms.get(roomId)
    if (!room) return false

    room.participants.add(deviceId)
    room.info.participantCount = room.participants.size

    if (!this.userRooms.has(deviceId)) {
      this.userRooms.set(deviceId, new Set())
    }
    this.userRooms.get(deviceId)!.add(roomId)

    this.emit('user-joined', roomId, deviceId, deviceName)
    return true
  }

  leaveRoom(deviceId: string, deviceName: string, roomId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room) return false

    room.participants.delete(deviceId)
    room.info.participantCount = room.participants.size

    const userRooms = this.userRooms.get(deviceId)
    if (userRooms) {
      userRooms.delete(roomId)
      if (userRooms.size === 0) {
        this.userRooms.delete(deviceId)
      }
    }

    this.emit('user-left', roomId, deviceId)
    return true
  }

  sendMessage(data: {
    roomId: string
    senderDeviceId: string
    senderDeviceName: string
    senderSessionId: string
    content: string
    type?: 'text' | 'system' | 'file' | 'code'
    metadata?: Record<string, unknown>
    replyTo?: string
  }): ChatMessage {
    const room = this.rooms.get(data.roomId)
    if (!room) {
      throw new Error('Room not found')
    }

    if (data.content.length > this.config!.maxMessageLength) {
      throw new Error('Message too long')
    }

    const message: ChatMessage = {
      messageId: this.generateMessageId(),
      roomId: data.roomId,
      senderDeviceId: data.senderDeviceId,
      senderDeviceName: data.senderDeviceName,
      senderSessionId: data.senderSessionId,
      content: data.content,
      type: data.type || 'text',
      metadata: data.metadata,
      timestamp: Date.now(),
      replyTo: data.replyTo
    }

    room.messages.push(message)
    room.info.lastMessageAt = message.timestamp

    // Trim history if needed
    if (room.messages.length > this.config!.maxHistoryPerRoom) {
      room.messages = room.messages.slice(-this.config!.maxHistoryPerRoom)
    }

    this.emit('message', message)
    return message
  }

  editMessage(messageId: string, roomId: string, newContent: string, deviceId: string): ChatMessage | null {
    const room = this.rooms.get(roomId)
    if (!room) return null

    const messageIndex = room.messages.findIndex(m => m.messageId === messageId)
    if (messageIndex === -1) return null

    const message = room.messages[messageIndex]
    if (message.senderDeviceId !== deviceId) {
      throw new Error('Not authorized to edit this message')
    }

    message.content = newContent
    message.edited = true

    this.emit('message-edited', message)
    return message
  }

  deleteMessage(messageId: string, roomId: string, deviceId: string): boolean {
    const room = this.rooms.get(roomId)
    if (!room) return false

    const messageIndex = room.messages.findIndex(m => m.messageId === messageId)
    if (messageIndex === -1) return false

    const message = room.messages[messageIndex]
    if (message.senderDeviceId !== deviceId) {
      throw new Error('Not authorized to delete this message')
    }

    room.messages.splice(messageIndex, 1)
    this.emit('message-deleted', messageId, roomId)
    return true
  }

  getHistory(roomId: string, limit: number = 100, before?: number): ChatMessage[] {
    const room = this.rooms.get(roomId)
    if (!room) return []

    let messages = room.messages
    if (before) {
      messages = messages.filter(m => m.timestamp < before)
    }
    return messages.slice(-limit)
  }

  setTyping(roomId: string, deviceId: string, deviceName: string, isTyping: boolean): void {
    this.emit('typing', roomId, deviceId, deviceName, isTyping)
  }

  getParticipants(roomId: string): string[] {
    const room = this.rooms.get(roomId)
    if (!room) return []
    return Array.from(room.participants)
  }

  getUserRooms(deviceId: string): string[] {
    return Array.from(this.userRooms.get(deviceId) || [])
  }

  private generateMessageId(): string {
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  }

  shutdown(): void {
    this.rooms.clear()
    this.userRooms.clear()
    this.ctx.logger.info('[cross-transfer] Chat service shut down')
  }
}