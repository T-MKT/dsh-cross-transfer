import { Service, Context } from '@deepseek-ai/cordis'
import { WebSocketServer, WebSocket, RawData } from 'ws'
import { IncomingMessage } from 'http'
import { createHash, randomBytes } from 'crypto'
import { createTypedEmitter, TypedEmitter } from './typed-emitter.js'

export interface WSServerConfig {
  path: string
  tokenSecret: string
  maxFileSize: number
  chunkSize: number
}

export interface WSSession {
  sessionId: string
  deviceId: string
  deviceName: string
  connectedAt: number
  lastActiveAt: number
  socket: WebSocket
  capabilities: Set<string>
  authenticated: boolean
  /** 远端地址；用于按 IP 限流。必须由 handleConnection 赋值 */
  remoteAddress?: string
}

/**
 * The public shape of a session: everything above except the socket, which is
 * never handed out (the server service owns it, not a caller), and except the
 * remote address, which is peer topology rather than session state.
 */
export type WSSessionSummary = Omit<WSSession, 'socket' | 'capabilities' | 'remoteAddress'> & {
  /** Capabilities as a JSON-safe array; the live session holds a Set. */
  capabilities: string[]
}

export interface WSMessage {
  type: string
  sessionId?: string
  deviceId?: string
  targetDeviceId?: string
  payload: unknown
  messageId?: string
}

/** payload 里带明文密码的三类房间帧；message 事件的观测副本里必须抹掉。 */
const SECRET_BEARING_TYPES = new Set(['room-create', 'room-join', 'room-password'])

/**
 * 观测用副本：把明文密码替换成 '***'。只作用于 message 事件的入参，
 * 门禁已经读走原值，处理结果不受影响。
 */
function redactSecrets(message: WSMessage): WSMessage {
  if (!SECRET_BEARING_TYPES.has(message.type)) return message
  const payload = message.payload
  if (payload === null || typeof payload !== 'object') return message
  if (typeof (payload as { password?: unknown }).password !== 'string') return message
  return { ...message, payload: { ...(payload as Record<string, unknown>), password: '***' } }
}

/**
 * The room gate owns every message that carries room semantics: room lifecycle,
 * room-scoped chat, and any custom type whose payload names a room. It is a port
 * so src/ws-server.ts never depends on the room implementation.
 */
export interface RoomGate {
  /** Non-null reply means "answer the requesting session"; null means the gate already broadcast. */
  handle(session: WSSession, message: WSMessage, server: WSServer): Promise<RoomGateReply | null>
  onSessionClosed(session: WSSession): void
}

export interface RoomGateReply {
  type: string
  payload: unknown
}

export interface WSServerEvents {
  connection: [session: WSSession]
  disconnection: [sessionId: string, reason: string]
  message: [session: WSSession, message: WSMessage]
  deviceConnected: [device: DeviceInfo]
  deviceDisconnected: [deviceId: string]
  error: [error: Error, session?: WSSession]
}

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  connectedAt: number
  lastActiveAt: number
  sessionCount: number
  capabilities: string[]
}

export class WSServer extends Service {
  private wss: WebSocketServer | null = null
  private config: WSServerConfig | null = null
  private sessions = new Map<string, WSSession>()
  private deviceRegistry = new Map<string, Set<string>>() // deviceId -> sessionIds
  private messageHandlers = new Map<string, (session: WSSession, message: WSMessage) => Promise<void>>()
  private pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: NodeJS.Timeout }>()
  private roomGate: RoomGate | null = null
  private emitter = createTypedEmitter<WSServerEvents>()

  constructor(ctx: Context) {
    super(ctx, 'wsServer')
    this.registerDefaultHandlers()
  }

  // TypedEmitter methods
  on<K extends keyof WSServerEvents>(event: K, listener: (...args: WSServerEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof WSServerEvents>(event: K, listener: (...args: WSServerEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof WSServerEvents>(event: K, ...args: WSServerEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof WSServerEvents>(event: K, listener: (...args: WSServerEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  initialize(config: WSServerConfig): void {
    this.config = config
    this.wss = new WebSocketServer({ noServer: true })
    this.wss.on('connection', this.handleConnection.bind(this))
    this.wss.on('error', (error) => this.emit('error', error))
    this.ctx.logger.info('[cross-transfer] WebSocket server initialized')
  }

  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer): void {
    if (!this.wss) return
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss!.emit('connection', ws, req)
    })
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url || '', `http://${req.headers.host}`)
    const token = url.searchParams.get('token')
    const deviceId = url.searchParams.get('deviceId') || this.generateDeviceId()
    const deviceName = url.searchParams.get('deviceName') || `Device-${deviceId.slice(0, 6)}`
    const capabilitiesParam = url.searchParams.get('capabilities')
    const capabilities = capabilitiesParam ? new Set(capabilitiesParam.split(',')) : new Set(['file-transfer', 'chat', 'git-sync'])

    if (!this.validateToken(token || '', deviceId)) {
      ws.close(4001, 'Invalid token')
      return
    }

    const sessionId = this.generateSessionId()
    const session: WSSession = {
      sessionId,
      deviceId,
      deviceName,
      connectedAt: Date.now(),
      lastActiveAt: Date.now(),
      socket: ws,
      capabilities,
      authenticated: true,
      // 房间门禁按 IP 限流要用它；不经过这里就没有第二个赋值点。
      remoteAddress: req.socket.remoteAddress ?? undefined
    }

    this.sessions.set(sessionId, session)

    if (!this.deviceRegistry.has(deviceId)) {
      this.deviceRegistry.set(deviceId, new Set())
    }
    this.deviceRegistry.get(deviceId)!.add(sessionId)

    // Check if this is a new device connection
    const isNewDevice = this.deviceRegistry.get(deviceId)!.size === 1

    this.ctx.logger.info(`[cross-transfer] Device ${deviceName} (${deviceId}) connected with session ${sessionId}`)

    // Send welcome message
    this.sendToSession(sessionId, {
      type: 'welcome',
      sessionId,
      payload: { sessionId, deviceId, deviceName, capabilities: Array.from(capabilities) }
    })

    // Notify other sessions on the same device
    this.broadcastToDevice(deviceId, {
      type: 'peer-connected',
      sessionId,
      deviceId,
      payload: { sessionId, deviceId, deviceName }
    }, sessionId)

    // Notify all devices about new device
    if (isNewDevice) {
      this.broadcastToAll({
        type: 'device-connected',
        deviceId: 'server',
        payload: { deviceId, deviceName, capabilities: Array.from(capabilities) }
      }, sessionId)
      this.emit('deviceConnected', {
        deviceId,
        deviceName,
        connectedAt: session.connectedAt,
        lastActiveAt: session.lastActiveAt,
        sessionCount: 1,
        capabilities: Array.from(capabilities)
      })
    }

    this.emit('connection', session)

    ws.on('message', (data: RawData) => {
      this.handleMessage(session, data.toString())
    })

    ws.on('close', (code: number, reason: Buffer) => {
      this.handleDisconnection(session, code, reason.toString())
    })

    ws.on('error', (error: Error) => {
      this.ctx.logger.warn('[cross-transfer] WebSocket error:', error)
      this.emit('error', error, session)
    })

    // Heartbeat
    const heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      } else {
        clearInterval(heartbeat)
      }
    }, 30000)

    ws.on('close', () => clearInterval(heartbeat))
  }

  private async handleMessage(session: WSSession, data: string): Promise<void> {
    try {
      const message: WSMessage = JSON.parse(data)
      session.lastActiveAt = Date.now()

      // Handle request-response pattern
      if (message.messageId && this.pendingRequests.has(message.messageId)) {
        const pending = this.pendingRequests.get(message.messageId)!
        clearTimeout(pending.timeout)
        this.pendingRequests.delete(message.messageId)

        if (message.type === 'error') {
          pending.reject(new Error(message.payload as string))
        } else {
          pending.resolve(message.payload)
        }
        return
      }

      // Room-scoped frames never reach the general handler table: without a gate
      // they are refused outright (fail-closed) and never relayed to anyone.
      if (this.isRoomScoped(message)) {
        await this.handleRoomScoped(session, message)
        // 观测事件拿到的是抹掉密码后的副本：订阅者不该看到明文密码。
        this.emit('message', session, redactSecrets(message))
        return
      }

      // Route to registered handler
      const handler = this.messageHandlers.get(message.type)
      if (handler) {
        await handler(session, message)
      } else {
        // Default: broadcast to target device or all
        if (message.targetDeviceId) {
          this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
        } else {
          this.broadcastToAll(message, session.sessionId)
        }
      }

      this.emit('message', session, message)
    } catch (error) {
      this.ctx.logger.warn('[cross-transfer] Failed to parse message:', error)
      this.sendToSession(session.sessionId, {
        type: 'error',
        sessionId: session.sessionId,
        payload: 'Invalid message format'
      })
    }
  }

  /**
   * A message carries room semantics when its type is room-scoped by name, or
   * when its payload names a room. The payload arm exists because a client
   * cannot be trusted to stay inside the documented type list: any custom type
   * that mentions a roomId would otherwise fall through to broadcastToAll.
   */
  isRoomScoped(message: WSMessage): boolean {
    if (typeof message.type !== 'string') return false
    if (message.type.startsWith('room-')) return true
    if (message.type === 'chat-message' || message.type === 'chat-history-request' || message.type === 'typing') {
      return true
    }
    const payload = message.payload
    if (payload === null || typeof payload !== 'object') return false
    return typeof (payload as { roomId?: unknown }).roomId === 'string'
  }

  private async handleRoomScoped(session: WSSession, message: WSMessage): Promise<void> {
    const gate = this.roomGate
    if (!gate) {
      this.sendRoomError(session, message, 'room-gate-unavailable', 'Room gate is not installed')
      return
    }

    let reply: RoomGateReply | null
    try {
      reply = await gate.handle(session, message, this)
    } catch (error) {
      // RoomError 的 code 直接回给调用方；其余异常统一归一化成 internal-error。
      const roomError = error as { code?: unknown; message?: unknown; retryAfterMs?: unknown }
      const code = typeof roomError?.code === 'string' ? roomError.code : 'internal-error'
      const text = typeof roomError?.message === 'string' ? roomError.message : 'Room gate failed'
      const retryAfterMs = typeof roomError?.retryAfterMs === 'number' ? roomError.retryAfterMs : undefined
      if (code !== 'internal-error') {
        this.ctx.logger.warn(`[cross-transfer] Room gate rejected ${message.type}: ${code} ${text}`)
      } else {
        this.ctx.logger.warn('[cross-transfer] Room gate failed:', error)
      }
      this.sendRoomError(session, message, code, text, retryAfterMs)
      return
    }

    if (!reply) return
    this.sendToSession(session.sessionId, {
      type: reply.type,
      sessionId: session.sessionId,
      // 回显请求帧的 messageId：客户端 request() 靠它配对，否则只能等超时。
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      payload: reply.payload
    })
  }

  /** 唯一的错误帧来源，保证 messageId 回显规则只有一处实现。 */
  private sendRoomError(
    session: WSSession,
    message: WSMessage,
    code: string,
    text: string,
    retryAfterMs?: number
  ): void {
    this.sendToSession(session.sessionId, {
      type: 'error',
      sessionId: session.sessionId,
      ...(message.messageId === undefined ? {} : { messageId: message.messageId }),
      payload: {
        code,
        message: text,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs })
      }
    })
  }

  private handleDisconnection(session: WSSession, code: number, reason: string): void {
    this.sessions.delete(session.sessionId)

    try {
      // 先让门禁摘掉这个会话的房间挂载，再广播设备级事件，
      // 否则 user-left 的快照里还会带着刚断开的会话。
      this.roomGate?.onSessionClosed(session)
    } catch (error) {
      this.ctx.logger.warn('[cross-transfer] Room gate failed on session close:', error)
    }

    const deviceSessions = this.deviceRegistry.get(session.deviceId)
    if (deviceSessions) {
      deviceSessions.delete(session.sessionId)
      const wasLastSession = deviceSessions.size === 0

      if (wasLastSession) {
        this.deviceRegistry.delete(session.deviceId)

        // Notify all devices about device disconnection
        this.broadcastToAll({
          type: 'device-disconnected',
          deviceId: 'server',
          payload: { deviceId: session.deviceId }
        })

        this.emit('deviceDisconnected', session.deviceId)
      } else {
        // Notify other sessions on the same device
        this.broadcastToDevice(session.deviceId, {
          type: 'peer-disconnected',
          sessionId: session.sessionId,
          deviceId: session.deviceId,
          payload: { sessionId: session.sessionId }
        })
      }
    }

    this.ctx.logger.info(`[cross-transfer] Device ${session.deviceName} (${session.deviceId}) disconnected: ${reason}`)
    this.emit('disconnection', session.sessionId, reason)
  }

  private registerDefaultHandlers(): void {
    // Ping/pong
    this.messageHandlers.set('ping', async (session) => {
      this.sendToSession(session.sessionId, {
        type: 'pong',
        sessionId: session.sessionId,
        payload: Date.now()
      })
    })

    // File transfer signaling
    this.messageHandlers.set('file-offer', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    this.messageHandlers.set('file-answer', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    this.messageHandlers.set('file-chunk', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    this.messageHandlers.set('file-complete', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    // Chat is room-scoped end to end: chat-message / chat-history-request / typing
    // are dispatched by handleMessage to the room gate, so no handler is registered
    // here (a registration would shadow the gate).

    // Git sync signaling
    this.messageHandlers.set('git-sync-request', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    this.messageHandlers.set('git-sync-response', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    // WebRTC signaling (for direct P2P)
    this.messageHandlers.set('webrtc-offer', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    this.messageHandlers.set('webrtc-answer', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })

    this.messageHandlers.set('webrtc-candidate', async (session, message) => {
      if (message.targetDeviceId) {
        this.broadcastToDevice(message.targetDeviceId, message, session.sessionId)
      }
    })
  }

  // Public API for services to register handlers
  onMessage(type: string, handler: (session: WSSession, message: WSMessage) => Promise<void>): void {
    this.messageHandlers.set(type, handler)
  }

  /** 只在 src/index.ts 调用：唯一的门禁安装点。 */
  setRoomGate(gate: RoomGate | null): void {
    this.roomGate = gate
  }

  getRoomGate(): RoomGate | null {
    return this.roomGate
  }

  sendToSession(sessionId: string, message: WSMessage): boolean {
    const session = this.sessions.get(sessionId)
    if (session && session.socket.readyState === WebSocket.OPEN) {
      try {
        session.socket.send(JSON.stringify(message))
        return true
      } catch (error) {
        this.ctx.logger.warn('[cross-transfer] Failed to send message:', error)
      }
    }
    return false
  }

  broadcastToDevice(deviceId: string, message: WSMessage, excludeSessionId?: string): number {
    const sessionIds = this.deviceRegistry.get(deviceId)
    if (!sessionIds) return 0

    let sent = 0
    for (const sessionId of sessionIds) {
      if (sessionId === excludeSessionId) continue
      if (this.sendToSession(sessionId, message)) sent++
    }
    return sent
  }

  broadcastToAll(message: WSMessage, excludeSessionId?: string): number {
    let sent = 0
    for (const session of this.sessions.values()) {
      if (session.sessionId === excludeSessionId) continue
      if (this.sendToSession(session.sessionId, message)) sent++
    }
    return sent
  }

  /**
   * Deliver to an explicit recipient set. Room delivery goes through here
   * because only the room gate knows who is currently in the room.
   * @returns how many sessions the frame actually reached.
   */
  broadcastToSessions(sessionIds: Iterable<string>, message: WSMessage, excludeSessionId?: string): number {
    let sent = 0
    for (const sessionId of sessionIds) {
      if (sessionId === excludeSessionId) continue
      if (this.sendToSession(sessionId, message)) sent++
    }
    return sent
  }

  // Request-response helper
  async request(sessionId: string, message: WSMessage, timeoutMs = 10000): Promise<unknown> {
    const messageId = randomBytes(16).toString('hex')
    const fullMessage = { ...message, messageId }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId)
        reject(new Error('Request timeout'))
      }, timeoutMs)

      this.pendingRequests.set(messageId, { resolve, reject, timeout })
      this.sendToSession(sessionId, fullMessage)
    })
  }

  getDevices(): DeviceInfo[] {
    return Array.from(this.deviceRegistry.entries()).map(([deviceId, sessionIds]) => {
      const firstSessionId = sessionIds.values().next().value
      const session = firstSessionId === undefined ? undefined : this.sessions.get(firstSessionId)
      return {
        deviceId,
        deviceName: session?.deviceName || 'Unknown',
        connectedAt: session?.connectedAt || 0,
        lastActiveAt: session?.lastActiveAt || 0,
        sessionCount: sessionIds.size,
        capabilities: session ? Array.from(session.capabilities) : []
      }
    })
  }

  /** Session summaries: the socket itself never leaves this service. */
  getSessions(): WSSessionSummary[] {
    return Array.from(this.sessions.values()).map(s => ({
      sessionId: s.sessionId,
      deviceId: s.deviceId,
      deviceName: s.deviceName,
      connectedAt: s.connectedAt,
      lastActiveAt: s.lastActiveAt,
      capabilities: Array.from(s.capabilities),
      authenticated: s.authenticated
    }))
  }

  getSession(sessionId: string): WSSession | undefined {
    return this.sessions.get(sessionId)
  }

  getDeviceSessions(deviceId: string): WSSession[] {
    const sessionIds = this.deviceRegistry.get(deviceId)
    if (!sessionIds) return []
    return Array.from(sessionIds).map(id => this.sessions.get(id)!).filter(Boolean)
  }

  private generateSessionId(): string {
    return randomBytes(16).toString('hex')
  }

  private generateDeviceId(): string {
    return randomBytes(8).toString('hex')
  }

  private validateToken(token: string, deviceId: string): boolean {
    if (!this.config?.tokenSecret) return true
    const expected = createHash('sha256').update(`${deviceId}:${this.config.tokenSecret}`).digest('hex')
    return token === expected
  }

  shutdown(): void {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    for (const session of this.sessions.values()) {
      session.socket.close(1001, 'Server shutting down')
    }
    this.sessions.clear()
    this.deviceRegistry.clear()
    this.ctx.logger.info('[cross-transfer] WebSocket server shut down')
  }
}