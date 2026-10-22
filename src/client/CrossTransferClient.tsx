import { Service, Context } from '@deepseek-ai/cordis'
import { createTypedEmitter, TypedEmitter } from '../typed-emitter.js'
// Type-only import: a value import here would drag node:crypto into the browser bundle.
import type { RoomInfo, RoomMember, RoomTicket, RoomRole, RoomErrorCode } from '../rooms.js'

export interface CrossTransferClientConfig {
  autoConnect?: boolean
  deviceName?: string
}

export interface TransferSession {
  id: string
  deviceId: string
  deviceName: string
  connectedAt: number
}

export interface PeerDevice {
  deviceId: string
  deviceName: string
  sessionCount: number
  capabilities: string[]
}

export interface WSMessage {
  type: string
  sessionId?: string
  deviceId?: string
  fromDeviceId?: string
  targetDeviceId?: string
  payload?: unknown
  messageId?: string
}

export interface FileTransferInfo {
  fileId: string
  fileName: string
  fileSize: number
  mimeType: string
  checksum: string
  chunkCount: number
  senderDeviceId: string
  senderDeviceName: string
  status: 'pending' | 'receiving' | 'complete' | 'failed' | 'cancelled'
  progress: number
  receivedChunks: number
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

export interface RepoConfig {
  repoId: string
  name: string
  localPath: string
  remoteUrl: string
  branch: string
  auth?: {
    type: 'token' | 'ssh'
    token?: string
    username?: string
  }
  autoSync?: boolean
  syncInterval?: number
}

export interface SyncResult {
  success: boolean
  operation: string
  repoId: string
  output?: string
  error?: string
  conflicts?: string[]
  filesChanged?: number
  commitsAhead?: number
  commitsBehind?: number
}

/**
 * 房间仓库凭据（§3）。浏览器端只负责把用户填的令牌带过去，服务端保证不落盘；
 * 与 src/room-workspace.ts 的同名形状保持一致。
 */
export interface RoomRepoAuthInput {
  /** 仅支持 token 形式（HTTPS Basic）。 */
  type: 'token'
  token: string
  /** 默认 'oauth2'（GitHub）或 'git'。 */
  username?: string
}

/** 房主建房/改配时提交的仓库配置（§3）。 */
export interface RoomRepoConfigInput {
  /** 必须是 http:// 或 https://；允许内嵌 userinfo，会被抽取成 auth 并从存储值里剥离。 */
  remoteUrl: string
  /** 默认 'main'。 */
  branch?: string
  auth?: RoomRepoAuthInput
  /** 默认 true。 */
  autoCommit?: boolean
  /** 默认 true。 */
  autoPush?: boolean
  commitAuthorName?: string   // 默认 'dsh-cross-transfer'
  commitAuthorEmail?: string  // 默认 'cross-transfer@dsh.local'
}

/** 对外投影：绝不包含 token、绝不包含未剥离 userinfo 的 URL（§3）。 */
export interface RoomRepoStatus {
  roomId: string
  configured: boolean
  /** 已剥离 userinfo；未配置时省略。 */
  remoteUrl?: string
  branch?: string
  authConfigured: boolean
  autoCommit: boolean
  autoPush: boolean
  updatedAt?: number
  /** 脱敏。 */
  updatedByDeviceId?: string
  bindings: WorkspaceBindingStatus[]
}

/** 单个成员的工作区绑定状态（§3）。 */
export interface WorkspaceBindingStatus {
  /** 脱敏 deviceId。 */
  deviceId: string
  deviceName: string
  bound: boolean
  /** 只对绑定者本人与房主返回真实路径；其他成员看到 undefined。 */
  workspacePath?: string
  repoReady?: boolean
  lastSync?: SyncSummary
}

/** 一次同步（自动或手动）的结果（§3）。失败也必须可见，error 非空。 */
export interface SyncSummary {
  at: number
  ok: boolean
  trigger: 'auto' | 'manual'
  /** 本次提交的文件数（含删除）。 */
  committed: number
  commitOid?: string
  pushed: boolean
  error?: string
}

/**
 * A failure the server described with a machine-readable code. The browser half
 * cannot reuse the host's RoomError (importing the class would pull node:crypto
 * into the bundle), so this mirrors it.
 */
export class RoomRequestError extends Error {
  readonly code: RoomErrorCode
  readonly retryAfterMs?: number

  constructor(code: RoomErrorCode, message: string, retryAfterMs?: number) {
    super(message)
    this.name = 'RoomRequestError'
    this.code = code
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs
  }
}

/** A room this client is currently in, as it is entitled to be (ticket included). */
export interface ActiveRoom {
  roomId: string
  name: string
  role: RoomRole
  ticket: string
  expiresAt: number
}

export interface RoomJoinResultPayload {
  room: RoomInfo
  member: RoomMember
  ticket: RoomTicket
}

export interface CreateRoomOptions {
  roomId?: string
  name?: string
  password: string
  maxMembers?: number
  discoverable?: boolean
  /** 建房时一并设置仓库（§5.1）；不传即「房主稍后配置」。 */
  repo?: RoomRepoConfigInput
}

export interface CrossTransferEvents {
  connected: [session: TransferSession]
  disconnected: [sessionId: string]
  message: [message: WSMessage]
  deviceList: [devices: PeerDevice[]]
  peerConnected: [peer: PeerDevice]
  peerDisconnected: [peer: PeerDevice]
  error: [error: Error]
  // File transfer
  fileOffer: [info: FileTransferInfo, fromDeviceId: string]
  fileProgress: [fileId: string, progress: { received: number; total: number; percentage: number }]
  fileComplete: [fileId: string, data: Uint8Array]
  fileError: [fileId: string, error: string]
  // Chat
  chatMessage: [message: ChatMessage]
  chatHistory: [messages: ChatMessage[]]
  chatUserJoined: [roomId: string, deviceId: string, deviceName: string]
  chatUserLeft: [roomId: string, deviceId: string]
  chatTyping: [roomId: string, deviceId: string, deviceName: string, isTyping: boolean]
  // Rooms. The payloads never carry a password: room membership is what the UI
  // renders, and a listener that logged an event would otherwise leak the gate.
  // roomJoined 带全 join 结果三件套（room/member/ticket），三者均无密码字段。
  roomJoined: [room: ActiveRoom, member: RoomMember, ticket: RoomTicket]
  roomLeft: [roomId: string]
  roomList: [rooms: RoomInfo[]]
  roomMembers: [roomId: string, members: RoomMember[]]
  roomClosed: [roomId: string, reason: string]
  roomMemberKicked: [roomId: string, deviceId: string, kickedByDeviceId: string]
  roomLocked: [roomId: string, locked: boolean]
  roomPasswordChanged: [roomId: string]
  activeRoomChanged: [room: ActiveRoom | null]
  // Room Git workspace (§5.1)：都是服务端按接收者逐个投影后的推送，客户端只按 roomId 存本地视图。
  roomGitStatus: [status: RoomRepoStatus]
  roomGitSync: [roomId: string, deviceId: string, result: SyncSummary]
  // Git sync
  syncProgress: [repoId: string, progress: { phase: string; loaded: number; total: number }]
  syncComplete: [result: SyncResult]
  syncError: [repoId: string, error: string, operation: string]
  syncConflict: [repoId: string, conflicts: string[]]
  repoList: [repos: RepoConfig[]]
}

const DEVICE_SECRET_KEY = 'dsh-cross-transfer-device-secret'
/** The pre-room key held a deviceId the client could simply invent; never trust it. */
const LEGACY_DEVICE_ID_KEY = 'dsh-cross-transfer-device-id'

/**
 * Room frames that also come back as the reply to a request. When such a frame
 * carries a messageId it is an answer and must not be replayed as a broadcast,
 * otherwise the same event fires twice (see handleMessage).
 */
const ROOM_REPLY_TYPES = new Set([
  'room-created',
  'room-joined',
  'room-left',
  'room-locked',
  'room-password-changed',
  'room-member-kicked',
  // 房间 Git 工作区（§5.1）：请求/应答同名（除 sync），应答帧只用于兑现请求，
  // 事件由无 messageId 的推送形态触发。
  'room-git-status',
  'room-workspace-candidates',
  'room-git-sync-result'
])

export class CrossTransferClient extends Service {
  private ws: WebSocket | null = null
  private session: TransferSession | null = null
  private deviceId: string = ''
  private deviceSecret: string | null = null
  private deviceName: string
  private token: string = ''
  private serverUrl: string = ''
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pendingRequests = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> }>()
  private messageIdCounter = 0
  private fileTransfers = new Map<string, FileTransferInfo>()
  private joinedRooms = new Map<string, ActiveRoom>()
  /** Passwords live in memory only: a persisted one would outlive the session it gates. */
  private roomPasswords = new Map<string, string>()
  private activeRoomId: string | null = null
  private rejoinInFlight = false
  /** Answered ticket re-issues, so one failure cannot spin into a rejoin loop. */
  private rejoinRetries = new Set<string>()
  private emitter = createTypedEmitter<CrossTransferEvents>()

  constructor(ctx: Context, config: CrossTransferClientConfig) {
    super(ctx, 'crossTransferClient')
    this.deviceName = config.deviceName || 'Browser'
    this.deviceSecret = this.restoreDeviceSecret()
    // deviceId is only known for sure after the host answers; it stays empty until
    // registerDevice() or the welcome frame fills it in.
    this.deviceId = ''
  }

  // TypedEmitter methods
  on<K extends keyof CrossTransferEvents>(event: K, listener: (...args: CrossTransferEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof CrossTransferEvents>(event: K, listener: (...args: CrossTransferEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof CrossTransferEvents>(event: K, ...args: CrossTransferEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof CrossTransferEvents>(event: K, listener: (...args: CrossTransferEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  // ---------------------------------------------------------------------------
  // identity
  // ---------------------------------------------------------------------------

  private storage(): Storage | null {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage
    } catch {
      // Blocked storage throws on access; the client still has to boot.
      return null
    }
  }

  private restoreDeviceSecret(): string | null {
    const store = this.storage()
    if (!store) return null
    let secret: string | null = null
    try {
      secret = store.getItem(DEVICE_SECRET_KEY)
      if (!secret && store.getItem(LEGACY_DEVICE_ID_KEY)) {
        // The old value was a self-chosen deviceId anyone could copy into their
        // own storage, so it must be discarded rather than upgraded.
        store.removeItem(LEGACY_DEVICE_ID_KEY)
      }
    } catch {
      return null
    }
    return secret
  }

  /**
   * sha256('xfer-device:' + secret).slice(0,16), matching src/rooms.ts
   * deriveDeviceId. WebCrypto only: a node:crypto import would break the browser
   * bundle, and this value is a stable local handle, not the credential itself.
   */
  private async computeDeviceId(secret: string): Promise<string> {
    const bytes = new TextEncoder().encode(`xfer-device:${secret}`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16)
  }

  /**
   * Ensure this browser holds a registered device identity. A stale secret the
   * host does not know (it restarted) is dropped and re-minted once — the
   * alternative is a device that can never connect again.
   */
  async ensureDeviceRegistered(): Promise<void> {
    if (this.deviceId) return

    // The secret may be in storage from an earlier page load but was not read at
    // construction time (storage can be unavailable then).
    const secret = this.deviceSecret ?? this.restoreDeviceSecret()
    if (secret) {
      try {
        await this.registerDevice(secret)
        return
      } catch (error) {
        if (!(error instanceof RoomRequestError) || error.code !== 'invalid-device') throw error
        // A host restart forgets every credential; keeping a dead secret would
        // leave this browser permanently unable to connect.
        this.deviceSecret = null
        this.storage()?.removeItem(DEVICE_SECRET_KEY)
      }
    }
    await this.registerDevice(undefined)
  }

  private async registerDevice(deviceSecret?: string): Promise<void> {
    const response = await fetch(`${this.httpBase()}/api/cross-transfer/devices/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecret, deviceName: this.deviceName })
    })
    const body = await this.readJson(response)
    if (!response.ok) throw this.describeHttpError(response, body)
    const data = body as { deviceId?: string; deviceSecret?: string; token?: string }
    if (!data.deviceId || !data.deviceSecret) throw new Error('Device registration returned no credentials')
    this.deviceSecret = data.deviceSecret
    this.deviceId = data.deviceId
    if (data.token) this.token = data.token
    // The default name was only a placeholder while the id was unknown.
    if (this.deviceName === 'Browser') this.deviceName = `Browser-${this.deviceId.slice(0, 6)}`
    this.storage()?.setItem(DEVICE_SECRET_KEY, data.deviceSecret)
  }

  /** Reply shape shared by the REST surface: { error: { code, message, retryAfterMs? } }. */
  private async readJson(response: Response): Promise<unknown> {
    try {
      return await response.json()
    } catch {
      return null
    }
  }

  private describeHttpError(response: Response, body: unknown): Error {
    const error = (body as { error?: unknown })?.error
    if (error && typeof error === 'object') {
      const payload = error as { code?: unknown; message?: unknown; retryAfterMs?: unknown }
      if (typeof payload.code === 'string') {
        return new RoomRequestError(
          payload.code as RoomErrorCode,
          typeof payload.message === 'string' ? payload.message : 'Request failed',
          typeof payload.retryAfterMs === 'number' ? payload.retryAfterMs : undefined
        )
      }
    }
    return new Error(`Request failed: ${response.status}`)
  }

  async connect(serverUrl: string, token?: string): Promise<void> {
    this.serverUrl = serverUrl
    this.token = token || this.token

    return new Promise((resolve, reject) => {
      const wsUrl = new URL(serverUrl)
      if (this.deviceId) {
        wsUrl.searchParams.set('deviceId', this.deviceId)
      }
      wsUrl.searchParams.set('deviceName', this.deviceName)
      if (this.token) {
        wsUrl.searchParams.set('token', this.token)
      }
      wsUrl.searchParams.set('capabilities', 'file-transfer,chat,git-sync')

      this.ws = new WebSocket(wsUrl.toString())

      this.ws.onopen = () => {
        this.ctx.logger.info('[cross-transfer] WebSocket connected')
      }

      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data)
          this.handleMessage(message)
        } catch (error) {
          this.ctx.logger.warn('[cross-transfer] Failed to parse message:', error)
        }
      }

      this.ws.onclose = (event) => {
        this.ctx.logger.info('[cross-transfer] Disconnected:', event.code, event.reason)
        const closedSessionId = this.session?.id ?? ''
        this.session = null
        this.emit('disconnected', closedSessionId)
        this.scheduleReconnect()
      }

      this.ws.onerror = (error) => {
        this.ctx.logger.error('[cross-transfer] WebSocket error:', error)
        this.emit('error', new Error('WebSocket connection failed'))
        if (!this.session) reject(new Error('WebSocket connection failed'))
      }

      const afterWelcome = (event: MessageEvent) => {
        try {
          const message: WSMessage = JSON.parse(event.data as string)
          this.handleMessage(message)
        } catch (error) {
          this.ctx.logger.warn('[cross-transfer] Failed to parse message:', error)
        }
      }
      this.ws.onmessage = (event) => {
        try {
          const message: WSMessage = JSON.parse(event.data as string)
          if (message.type === 'welcome' && message.payload) {
            const payload = message.payload as { sessionId: string; deviceId: string; deviceName: string }
            if (payload.sessionId) {
              if (payload.deviceId) this.deviceId = payload.deviceId
              this.session = {
                id: payload.sessionId,
                deviceId: this.deviceId,
                deviceName: this.deviceName,
                connectedAt: Date.now()
              }
              this.emit('connected', this.session)
              this.flushPendingMessages()
              // A reconnect starts a fresh session on the server; without this the
              // user is silently no longer in the room they were reading.
              void this.rejoinRooms()
              resolve()
              this.ws!.onmessage = afterWelcome
              return
            }
          }
        } catch {}
        afterWelcome(event)
      }

      setTimeout(() => {
        if (!this.session) {
          this.ws?.close()
          reject(new Error('Connection timeout'))
        }
      }, 10000)
    })
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      // A host restart mints a new token secret, so re-acquire before dialing.
      // A failed attempt (host still down) re-arms the timer.
      this.reconnect().catch(() => this.scheduleReconnect())
    }, 3000)
  }

  private handleMessage(message: WSMessage): void {
    // A reply frame resolves its pending request first, then returns: replaying it
    // through the broadcast switch below would emit the same event twice.
    if (message.messageId && this.pendingRequests.has(message.messageId)) {
      const pending = this.pendingRequests.get(message.messageId)!
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(message.messageId)

      if (message.type === 'error') {
        // 应答型错误帧只 reject 请求方；再落进下面的广播分支会把同一错误重复上报给全局 error 事件。
        pending.reject(this.toRequestError(message.payload))
        return
      }
      pending.resolve(message.payload)

      if (ROOM_REPLY_TYPES.has(message.type)) {
        this.applyRoomReply(message)
        return
      }
      // Non-room replies may also be broadcasts (e.g. a file chunk); keep the
      // historical behaviour of handling them too.
    }

    switch (message.type) {
      case 'welcome':
        // connect() 的首帧拦截只处理首个 welcome；这里接住后续/直接灌入的 welcome，
        // 重发 room-join 恢复成员资格。rejoinInFlight 保证与 connect 那处不会重复进房。
        void this.rejoinRooms()
        break
      case 'pong':
        break
      case 'peer-connected':
        this.emit('peerConnected', message.payload as PeerDevice)
        break
      case 'peer-disconnected':
        this.emit('peerDisconnected', message.payload as PeerDevice)
        break
      case 'device-connected':
        this.fetchDevices()
        break
      case 'device-disconnected':
        this.fetchDevices()
        break
      case 'device-list':
        this.emit('deviceList', (message.payload as { devices: PeerDevice[] }).devices)
        break
      case 'file-offer':
        this.handleFileOffer(message)
        break
      case 'file-chunk':
        this.handleFileChunk(message)
        break
      case 'file-complete':
        this.handleFileComplete(message)
        break
      case 'file-error':
        {
          const payload = message.payload as { fileId: string; error: string }
          this.emit('fileError', payload.fileId, payload.error)
        }
        break
      case 'chat-message':
        this.emit('chatMessage', message.payload as ChatMessage)
        break
      case 'chat-history':
        this.emit('chatHistory', (message.payload as { messages: ChatMessage[] }).messages)
        break
      case 'user-joined':
        {
          const payload = message.payload as { roomId: string; deviceId: string; deviceName: string }
          this.emit('chatUserJoined', payload.roomId, payload.deviceId, payload.deviceName)
        }
        break
      case 'user-left':
        {
          const payload = message.payload as { roomId: string; deviceId: string }
          this.emit('chatUserLeft', payload.roomId, payload.deviceId)
        }
        break
      case 'typing':
        {
          const payload = message.payload as { roomId: string; deviceId: string; deviceName: string; isTyping: boolean }
          this.emit('chatTyping', payload.roomId, payload.deviceId, payload.deviceName, payload.isTyping)
        }
        break
      case 'room-created':
      case 'room-joined':
        this.rememberRoom(message.payload as RoomJoinResultPayload, false)
        break
      case 'room-left':
        this.applyRoomLeft((message.payload as { roomId?: string })?.roomId)
        break
      case 'room-closed':
        {
          const payload = message.payload as { roomId?: string; reason?: string }
          if (payload?.roomId) this.forgetRoom(payload.roomId)
          this.emit('roomClosed', payload?.roomId ?? '', payload?.reason ?? '')
        }
        break
      case 'room-list':
        this.emit('roomList', this.roomsFromPayload(message.payload))
        break
      case 'room-members':
        {
          const payload = message.payload as { roomId: string; members: RoomMember[] }
          this.emit('roomMembers', payload.roomId, payload.members ?? [])
        }
        break
      case 'room-member-kicked':
        {
          const payload = message.payload as { roomId: string; deviceId: string; kickedByDeviceId: string }
          // The kicked device's own sessions get this too; the room is gone for it.
          if (payload.deviceId === this.deviceId) this.forgetRoom(payload.roomId)
          this.emit('roomMemberKicked', payload.roomId, payload.deviceId, payload.kickedByDeviceId)
        }
        break
      case 'room-locked':
        {
          const payload = message.payload as { roomId: string; locked: boolean }
          this.emit('roomLocked', payload.roomId, payload.locked)
        }
        break
      case 'room-password-changed':
        this.emit('roomPasswordChanged', (message.payload as { roomId: string }).roomId)
        break
      case 'room-git-status':
        // 只有推送形态（无 messageId）会走到这里：带 messageId 的应答已在上面兑现请求并 return。
        this.emit('roomGitStatus', message.payload as RoomRepoStatus)
        break
      case 'room-git-sync-result':
        {
          const payload = message.payload as { roomId: string; deviceId: string; result: SyncSummary }
          this.emit('roomGitSync', payload.roomId, payload.deviceId, payload.result)
        }
        break
      case 'sync-progress':
        {
          const payload = message.payload as { repoId: string; progress: { phase: string; loaded: number; total: number } }
          this.emit('syncProgress', payload.repoId, payload.progress)
        }
        break
      case 'sync-complete':
        this.emit('syncComplete', message.payload as SyncResult)
        break
      case 'sync-error':
        {
          const payload = message.payload as { repoId: string; error: string; operation: string }
          this.emit('syncError', payload.repoId, payload.error, payload.operation)
        }
        break
      case 'sync-conflict':
        {
          const payload = message.payload as { repoId: string; conflicts: string[] }
          this.emit('syncConflict', payload.repoId, payload.conflicts)
        }
        break
      case 'repo-list':
        this.emit('repoList', (message.payload as { repos: RepoConfig[] }).repos)
        break
      case 'error':
        this.emit('error', this.toRequestError(message.payload))
        break
      default:
        break
    }
  }

  /**
   * Error frames arrive either as the legacy plain string or as an object with a
   * machine-readable code. Both must keep working; callers branch on `code`.
   */
  private toRequestError(payload: unknown): Error {
    if (payload && typeof payload === 'object') {
      const shape = payload as { code?: unknown; message?: unknown; retryAfterMs?: unknown }
      if (typeof shape.code === 'string') {
        const message = typeof shape.message === 'string' ? shape.message : shape.code
        return new RoomRequestError(
          shape.code as RoomErrorCode,
          message,
          typeof shape.retryAfterMs === 'number' ? shape.retryAfterMs : undefined
        )
      }
    }
    return new Error(typeof payload === 'string' ? payload : String(payload))
  }

  /** `room-list` payloads are frames, so tolerate both `{rooms:[…]}` and a bare array. */
  private roomsFromPayload(payload: unknown): RoomInfo[] {
    if (Array.isArray(payload)) return payload as RoomInfo[]
    const rooms = (payload as { rooms?: RoomInfo[] } | null)?.rooms
    return Array.isArray(rooms) ? rooms : []
  }

  private rememberRoom(payload: RoomJoinResultPayload, replayed: boolean): void {
    if (!payload?.room || !payload.ticket) return
    const active: ActiveRoom = {
      roomId: payload.room.roomId,
      name: payload.room.name,
      role: payload.ticket.role,
      ticket: payload.ticket.ticket,
      expiresAt: payload.ticket.expiresAt
    }
    this.joinedRooms.set(active.roomId, active)
    this.activeRoomId = active.roomId
    this.rejoinRetries.delete(active.roomId)
    // 事件带全 join 结果（room/member/ticket）：UI 需要成员行与票据到期时间，
    // 三者都不含密码，不会破坏「事件不外传密码」的约定。
    this.emit('roomJoined', active, payload.member, payload.ticket)
    if (!replayed) this.emit('activeRoomChanged', active)
  }

  private applyRoomLeft(roomId: string | undefined): void {
    if (!roomId) return
    this.forgetRoom(roomId)
    this.emit('roomLeft', roomId)
  }

  private forgetRoom(roomId: string): void {
    if (!roomId) return
    this.joinedRooms.delete(roomId)
    this.roomPasswords.delete(roomId)
    this.rejoinRetries.delete(roomId)
    if (this.activeRoomId === roomId) {
      this.activeRoomId = this.joinedRooms.size > 0 ? Array.from(this.joinedRooms.keys())[0] : null
      this.emit('activeRoomChanged', this.getActiveRoom())
    }
  }

  /** A reply frame carries the same data a broadcast would; apply it without re-emitting. */
  private applyRoomReply(message: WSMessage): void {
    switch (message.type) {
      case 'room-created':
      case 'room-joined':
        this.rememberRoom(message.payload as RoomJoinResultPayload, true)
        break
      case 'room-left':
        this.forgetRoom((message.payload as { roomId?: string })?.roomId ?? '')
        break
      case 'room-member-kicked':
        {
          const payload = message.payload as { roomId: string; deviceId: string }
          if (payload.deviceId === this.deviceId) this.forgetRoom(payload.roomId)
        }
        break
      default:
        // room-locked / room-password-changed replies need no local state change.
        break
    }
  }

  /**
   * 请求 type → 应答 type 的协议映射。客户端自己不发应答；这是请求/应答契约的
   * 参考实现，测试的 mock 服务端靠它造出与真实服务端一致的回帧。
   */
  private replyTypeFor(type: string): string {
    switch (type) {
      case 'room-create': return 'room-created'
      case 'room-join': return 'room-joined'
      case 'room-leave': return 'room-left'
      case 'room-close': return 'room-closed'
      case 'room-kick': return 'room-member-kicked'
      case 'room-password': return 'room-password-changed'
      case 'room-lock': return 'room-locked'
      case 'room-list': return 'room-list'
      case 'room-members': return 'room-members'
      // 契约 §4.5：这五个请求的应答统一是 room-git-status（只有 candidates/sync 例外）。
      // 少了这五条，测试里的 mock 服务端会回成与请求同名的帧，与真实服务端不一致。
      case 'room-git-config':
      case 'room-git-clear':
      case 'room-git-status':
      case 'room-workspace-bind':
      case 'room-workspace-unbind':
        return 'room-git-status'
      case 'room-git-sync': return 'room-git-sync-result'
      case 'chat-message': return 'chat-message-ack'
      case 'chat-history-request': return 'chat-history'
      default: return type
    }
  }

  /**
   * 请求帧对应的应答 payload（契约参考实现，供测试的 mock 服务端使用）。
   * 字段取自请求本身，与 src/rooms.ts 的 RoomJoinResult/RoomLeaveResult 对齐；
   * 票据固定为 ticket-<房号>，expiresAt 用测试夹具同一时刻。
   */
  private replyPayloadFor(message: WSMessage): unknown {
    const payload = (message.payload ?? {}) as Record<string, unknown>
    const roomId = typeof payload.roomId === 'string' ? payload.roomId : ''
    switch (message.type) {
      case 'room-create':
      case 'room-join': {
        const role: RoomRole = message.type === 'room-create' ? 'owner' : 'member'
        return {
          room: {
            roomId,
            name: typeof payload.name === 'string' ? payload.name : '',
            ownerDeviceId: 'aaaa…bbbb',
            ownerOnline: true,
            createdAt: 1699999999000,
            lastActivityAt: 1699999999000,
            memberCount: 1,
            maxMembers: typeof payload.maxMembers === 'number' ? payload.maxMembers : 16,
            locked: false,
            discoverable: payload.discoverable !== false,
            repoConfigured: false
          },
          member: { deviceId: this.deviceId, deviceName: this.deviceName, role, joinedAt: 1699999999000, sessionCount: 1, online: true },
          ticket: { ticket: `ticket-${roomId}`, roomId, deviceId: this.deviceId, role, issuedAt: 1699999999000, expiresAt: 1700000000000 }
        }
      }
      case 'room-leave':
        return { roomId, deviceId: this.deviceId, removed: true, closed: false }
      case 'room-close':
        return { roomId, reason: 'closed-by-owner' }
      case 'room-kick':
        return { roomId, deviceId: typeof payload.deviceId === 'string' ? payload.deviceId : '', kickedByDeviceId: this.deviceId }
      case 'room-password':
        return { roomId }
      case 'room-lock':
        return { roomId, locked: payload.locked === true }
      case 'room-list':
        return { rooms: [] }
      case 'room-members':
        return { roomId, members: [] }
      case 'room-git-config':
      case 'room-git-clear':
      case 'room-git-status':
      case 'room-workspace-bind':
      case 'room-workspace-unbind': {
        // 最小可用的 RoomRepoStatus：字段取自请求（配置请求带 repo），
        // 没给就退到服务端默认值，保证 mock 与真实投影一样「无 token、无 userinfo」。
        const repo = payload.repo as RoomRepoConfigInput | undefined
        const configured = message.type !== 'room-git-clear'
        return {
          roomId,
          configured,
          ...(configured && repo?.remoteUrl ? { remoteUrl: repo.remoteUrl } : {}),
          // 未配置时按 §3 的投影习惯省略 branch，不要留一个 'main' 的假值。
          ...(configured ? { branch: repo?.branch ?? 'main' } : {}),
          authConfigured: configured && repo?.auth !== undefined,
          autoCommit: repo?.autoCommit !== false,
          autoPush: repo?.autoPush !== false,
          bindings: []
        }
      }
      case 'room-workspace-candidates':
        return { roomId, paths: [] }
      case 'room-git-sync':
        return { roomId, result: { at: 1699999999000, ok: true, trigger: 'manual', committed: 0, pushed: true } }
      case 'chat-message':
        return { ...payload, messageId: 'mock-ack', senderDeviceId: this.deviceId, senderDeviceName: this.deviceName, senderSessionId: '', timestamp: 1699999999000 }
      case 'chat-history-request':
        return { roomId, messages: [] }
      default:
        return {}
    }
  }

  /**
   * Re-enter every room this client was in. Passwords are memory-only, so a page
   * reload loses them by design; a reconnect keeps them.
   */
  private async rejoinRooms(): Promise<void> {
    if (this.rejoinInFlight || this.roomPasswords.size === 0) return
    this.rejoinInFlight = true
    try {
      for (const [roomId, password] of Array.from(this.roomPasswords)) {
        try {
          await this.request({ type: 'room-join', payload: { roomId, password } }, 15000)
        } catch (error) {
          // A rejoin failure is reported, never retried: a lockout would only grow.
          this.emit('error', error instanceof Error ? error : new Error(String(error)))
        }
      }
    } finally {
      this.rejoinInFlight = false
    }
  }

  /**
   * 房间操作的公共通道：invalid-ticket 时用内存里的密码自动重进一次再重试原操作；
   * 成功的应答则顺手检查本地票据视图，已过期就静默重签，省掉下一发的 401。
   */
  private async roomRequest<T>(message: WSMessage, roomId?: string, timeoutMs?: number): Promise<T> {
    try {
      const result = await this.request(message, timeoutMs) as T
      if (roomId) this.reissueIfTicketStale(roomId)
      return result
    } catch (error) {
      if (roomId && error instanceof RoomRequestError && error.code === 'invalid-ticket') {
        if (await this.handleTicketExpired(error, roomId)) {
          return await this.request(message, timeoutMs) as T
        }
      }
      throw error
    }
  }

  /** 本地票据视图已过期（expiresAt 已过）：趁下一次操作前静默重签一次。 */
  private reissueIfTicketStale(roomId: string): void {
    if (!this.roomPasswords.has(roomId) || this.rejoinRetries.has(roomId)) return
    const room = this.joinedRooms.get(roomId)
    if (!room || room.expiresAt > Date.now()) return
    void this.handleTicketExpired(new RoomRequestError('invalid-ticket', 'Ticket has expired'), roomId, true)
  }

  /**
   * 票据失效后的唯一一次自动重进。有密码就重发 room-join 并返回 true；没密码或
   * 已有一笔重进在途时只上报错误（quiet 用于顺手重签：不值得为它喊一嗓子）。
   */
  private async handleTicketExpired(error: RoomRequestError, roomId: string, quiet = false): Promise<boolean> {
    if (!roomId) return false
    const password = this.roomPasswords.get(roomId)
    if (!password || this.rejoinRetries.has(roomId)) {
      if (!quiet) this.emit('error', error)
      return false
    }
    this.rejoinRetries.add(roomId)
    try {
      await this.request({ type: 'room-join', payload: { roomId, password } })
      return true
    } catch (retryError) {
      this.emit('error', retryError instanceof Error ? retryError : new Error(String(retryError)))
      return false
    } finally {
      // 重进失败不永久拉黑该房间：下一次操作仍允许再试一次。
      this.rejoinRetries.delete(roomId)
    }
  }

  private handleFileOffer(message: WSMessage): void {
    const payload = message.payload as FileTransferInfo
    const info: FileTransferInfo = {
      ...payload,
      status: 'pending',
      progress: 0,
      receivedChunks: 0
    }
    this.fileTransfers.set(info.fileId, info)
    this.emit('fileOffer', info, message.fromDeviceId || '')
  }

  private handleFileChunk(message: WSMessage): void {
    const payload = message.payload as { fileId: string; chunkIndex: number; totalChunks: number }
    const info = this.fileTransfers.get(payload.fileId)
    if (info) {
      info.receivedChunks = payload.chunkIndex + 1
      info.progress = (info.receivedChunks / info.chunkCount) * 100
      info.status = 'receiving'
      this.emit('fileProgress', payload.fileId, {
        received: info.receivedChunks,
        total: info.chunkCount,
        percentage: info.progress
      })
    }
  }

  private handleFileComplete(message: WSMessage): void {
    const payload = message.payload as { fileId: string; data: number[] }
    const info = this.fileTransfers.get(payload.fileId)
    if (info) {
      info.status = 'complete'
      info.progress = 100
      const data = new Uint8Array(payload.data)
      this.emit('fileComplete', payload.fileId, data)
      this.fileTransfers.delete(payload.fileId)
    }
  }

  private flushPendingMessages(): void {
    // No pending messages in this implementation
  }

  private generateMessageId(): string {
    return `req_${Date.now()}_${++this.messageIdCounter}`
  }

  private send(message: WSMessage): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false
    }

    try {
      this.ws.send(JSON.stringify(message))
      return true
    } catch (error) {
      this.ctx.logger.warn('[cross-transfer] Failed to send message:', error)
      return false
    }
  }

  private async request(message: WSMessage, timeoutMs = 10000): Promise<unknown> {
    const messageId = this.generateMessageId()
    const fullMessage = { ...message, messageId }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(messageId)
        reject(new Error('Request timeout'))
      }, timeoutMs)

      this.pendingRequests.set(messageId, { resolve, reject, timeout })
      this.send(fullMessage)
    })
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** The HTTP base for this plugin's REST surface, derived from the WS URL. */
  private httpBase(): string {
    return this.serverUrl.replace(/^ws/, 'http').replace(/\/api\/cross-transfer$/, '')
  }

  /**
   * Trade this device's credentials for a host token. Called before every dial
   * because a host restart mints a new token secret. `tokenUrl` exists for the
   * first connect, which happens before `serverUrl` is set; legacy callers pass
   * the old `/token` path, which is normalized onto the contract's `/devices/token`.
   */
  async fetchToken(tokenUrl?: string): Promise<string> {
    const secret = this.deviceSecret ?? this.restoreDeviceSecret()
    const base = (tokenUrl ?? `${this.httpBase()}/api/cross-transfer/devices/token`).replace(/\/token$/, '')
    // 路由归一化：token 端点固定在 /devices/token（src/index.ts 的路由表），旧路径也落到这里。
    const endpoint = `${base.endsWith('/devices') ? base : `${base}/devices`}/token`

    if (!secret) {
      await this.ensureDeviceRegistered()
      // register already returned a usable token.
      if (this.token) return this.token
      throw new Error('Device registration returned no token')
    }

    this.deviceSecret = secret
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`
      },
      body: JSON.stringify({ deviceId: this.deviceId })
    })
    const body = await this.readJson(response)
    if (!response.ok) throw this.describeHttpError(response, body)
    const data = body as { token?: string; deviceId?: string }
    if (!data.token) throw new Error('Token request returned no token')
    this.token = data.token
    if (data.deviceId) this.deviceId = data.deviceId
    return this.token
  }

  getToken(): string {
    return this.token
  }

  async fetchDevices(): Promise<PeerDevice[]> {
    const response = await fetch(`${this.httpBase()}/api/cross-transfer/devices`)
    const data = await response.json()
    this.emit('deviceList', data.devices || [])
    return data.devices || []
  }

  getSession(): TransferSession | null {
    return this.session
  }

  getDeviceId(): string {
    return this.deviceId
  }

  getDeviceName(): string {
    return this.deviceName
  }

  setDeviceName(name: string): void {
    this.deviceName = name
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN && this.session !== null
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect')
      this.ws = null
    }
    this.session = null
  }

  /** Re-establish the connection from scratch, acquiring a fresh token first. */
  async reconnect(): Promise<void> {
    this.disconnect()
    await this.ensureDeviceRegistered()
    // 不传 tokenUrl：serverUrl 此时已就位，让 fetchToken 自己推导 /devices/token。
    await this.fetchToken()
    await this.connect(this.serverUrl, this.token)
  }

  // File Transfer
  async sendFile(file: File, targetDeviceId: string): Promise<string> {
    // Compute checksum
    const buffer = await file.arrayBuffer()
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer)
    const checksum = Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')

    const result = await this.request({
      type: 'file-initiate',
      targetDeviceId,
      payload: {
        fileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        checksum,
        senderDeviceId: this.deviceId,
        senderDeviceName: this.deviceName
      }
    }) as { fileId: string; chunkSize: number }

    const fileId = result.fileId
    const chunkSize = result.chunkSize

    // Send chunks
    const totalChunks = Math.ceil(file.size / chunkSize)
    for (let i = 0; i < totalChunks; i++) {
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const chunk = buffer.slice(start, end)

      await this.request({
        type: 'file-chunk',
        targetDeviceId,
        payload: {
          fileId,
          chunkIndex: i,
          totalChunks,
          data: Array.from(new Uint8Array(chunk))
        }
      }, 30000)
    }

    // Send complete
    await this.request({
      type: 'file-complete',
      targetDeviceId,
      payload: { fileId }
    })

    return fileId
  }

  cancelFile(fileId: string): void {
    const info = this.fileTransfers.get(fileId)
    if (info) {
      info.status = 'cancelled'
      this.fileTransfers.delete(fileId)
    }
  }

  // Rooms
  async createRoom(options: CreateRoomOptions): Promise<ActiveRoom> {
    // repo 为 undefined 时不放这个键：服务端用「键是否存在」区分「不配置」与「清空」，
    // 而 JSON.stringify 也会丢掉 undefined，这里显式展开让两种路径行为一致。
    const repo = options.repo
    const payload = await this.request({
      type: 'room-create',
      payload: {
        roomId: options.roomId,
        name: options.name,
        password: options.password,
        maxMembers: options.maxMembers,
        discoverable: options.discoverable,
        ...(repo === undefined ? {} : { repo })
      }
    }) as RoomJoinResultPayload
    // 房号可能由服务端生成，一切以应答为准；密码只进内存，供断线重进使用。
    const roomId = payload?.room?.roomId
    if (!roomId || !payload.ticket) throw new Error('Room creation returned no ticket')
    this.roomPasswords.set(roomId, options.password)
    if (!this.joinedRooms.has(roomId)) this.rememberRoom(payload, true)
    return this.joinedRooms.get(roomId)!
  }

  async joinRoom(roomId: string, password: string): Promise<ActiveRoom> {
    // 密码先入内存：票据一旦失效，自动重进只能靠它。
    this.roomPasswords.set(roomId, password)
    try {
      return await this.enterRoom(roomId, password)
    } catch (error) {
      // 进房失败就不该留着这个密码，否则重连会拿它反复重试。
      if (this.roomPasswords.get(roomId) === password) this.roomPasswords.delete(roomId)
      throw error
    }
  }

  /** 无密码进房：仅当服务端仍认这个设备是成员（成员快速通道）时才会成功。 */
  async enterRoom(roomId: string, password?: string): Promise<ActiveRoom> {
    try {
      const payload = await this.request({
        type: 'room-join',
        payload: password === undefined ? { roomId } : { roomId, password }
      }) as RoomJoinResultPayload
      if (password !== undefined) this.roomPasswords.set(roomId, password)
      // 应答路径（applyRoomReply）通常已写入 joinedRooms；这里兜底接住迟到的无 messageId 应答。
      if (!this.joinedRooms.has(roomId) && payload?.room) this.rememberRoom(payload, true)
      const room = this.joinedRooms.get(roomId)
      if (!room) throw new Error('Room join returned no ticket')
      return room
    } catch (error) {
      if (error instanceof RoomRequestError && error.code === 'invalid-ticket') {
        // 服务端判定票据失效：内存里还有密码就重进一次，成功即视为已进房。
        if (await this.handleTicketExpired(error, roomId)) {
          const room = this.joinedRooms.get(roomId)
          if (room) return room
        }
      }
      throw error
    }
  }

  async leaveRoom(roomId: string): Promise<void> {
    await this.request({ type: 'room-leave', payload: { roomId } })
    // The server also broadcasts a room-left frame for the other sessions of this
    // device; dropping the password here stops a rejoin after we chose to leave.
    this.forgetRoom(roomId)
  }

  async closeRoom(roomId: string): Promise<void> {
    await this.request({ type: 'room-close', payload: { roomId } })
    this.forgetRoom(roomId)
  }

  /** `deviceId` is the real id from the room-members response / a WS broadcast payload. */
  async kickMember(roomId: string, deviceId: string): Promise<void> {
    await this.roomRequest({ type: 'room-kick', payload: { roomId, deviceId } }, roomId)
  }

  async changeRoomPassword(roomId: string, password: string): Promise<void> {
    const previous = this.roomPasswords.get(roomId)
    // 先记新密码：服务端确认后旧密码即刻作废，紧随其后的自动重进必须用新密码。
    this.roomPasswords.set(roomId, password)
    try {
      await this.roomRequest({ type: 'room-password', payload: { roomId, password } }, roomId)
    } catch (error) {
      if (previous === undefined) this.roomPasswords.delete(roomId)
      else this.roomPasswords.set(roomId, previous)
      throw error
    }
  }

  async setRoomLocked(roomId: string, locked: boolean): Promise<void> {
    await this.roomRequest({ type: 'room-lock', payload: { roomId, locked } }, roomId)
  }

  // 列表是公开投影，与成员资格无关：不重试、不重签（契约规定 listRooms 不做恢复）。
  async listRooms(): Promise<RoomInfo[]> {
    const payload = await this.request({ type: 'room-list', payload: {} }) as { rooms: RoomInfo[] }
    return payload.rooms ?? []
  }

  async requestRoomMembers(roomId: string): Promise<RoomMember[]> {
    const payload = await this.roomRequest<{ members: RoomMember[] }>({ type: 'room-members', payload: { roomId } }, roomId)
    return payload.members ?? []
  }

  async sendChatMessage(roomId: string, content: string, type: 'text' | 'code' | 'file' = 'text', metadata?: Record<string, unknown>): Promise<ChatMessage> {
    return await this.roomRequest<ChatMessage>({
      type: 'chat-message',
      payload: { roomId, content, type, metadata }
    }, roomId, 15000)
  }

  requestChatHistory(roomId: string, limit = 100): void {
    this.send({
      type: 'chat-history-request',
      payload: { roomId, limit }
    })
  }

  setTyping(roomId: string, isTyping: boolean): void {
    this.send({
      type: 'typing',
      payload: { roomId, isTyping }
    })
  }

  getJoinedRooms(): ActiveRoom[] {
    return Array.from(this.joinedRooms.values())
  }

  getActiveRoom(): ActiveRoom | null {
    if (!this.activeRoomId) return null
    return this.joinedRooms.get(this.activeRoomId) ?? null
  }

  getRoomPassword(roomId: string): string | null {
    return this.roomPasswords.get(roomId) ?? null
  }

  setActiveRoom(roomId: string): void {
    const room = this.joinedRooms.get(roomId)
    if (!room) return
    this.activeRoomId = roomId
    this.emit('activeRoomChanged', room)
  }

  // -------------------------------------------------------------------------
  // 房间 Git 工作区（§5.1）
  // -------------------------------------------------------------------------
  // 全部走 roomRequest：票据失效时用内存里的密码自动重进一次再重试，
  // 与其它房间操作共用同一套恢复语义（权限判定在服务端，客户端只透传）。

  async setRoomGit(roomId: string, repo: RoomRepoConfigInput): Promise<RoomRepoStatus> {
    return await this.roomRequest<RoomRepoStatus>({ type: 'room-git-config', payload: { roomId, repo } }, roomId)
  }

  async clearRoomGit(roomId: string): Promise<RoomRepoStatus> {
    return await this.roomRequest<RoomRepoStatus>({ type: 'room-git-clear', payload: { roomId } }, roomId)
  }

  async getRoomGitStatus(roomId: string): Promise<RoomRepoStatus> {
    return await this.roomRequest<RoomRepoStatus>({ type: 'room-git-status', payload: { roomId } }, roomId)
  }

  async bindRoomWorkspace(roomId: string, path: string): Promise<RoomRepoStatus> {
    return await this.roomRequest<RoomRepoStatus>({ type: 'room-workspace-bind', payload: { roomId, path } }, roomId)
  }

  async unbindRoomWorkspace(roomId: string): Promise<RoomRepoStatus> {
    return await this.roomRequest<RoomRepoStatus>({ type: 'room-workspace-unbind', payload: { roomId } }, roomId)
  }

  async listWorkspaceCandidates(roomId: string): Promise<string[]> {
    const payload = await this.roomRequest<{ roomId: string; paths: string[] }>(
      { type: 'room-workspace-candidates', payload: { roomId } }, roomId)
    return payload.paths ?? []
  }

  async syncRoomGit(roomId: string): Promise<SyncSummary> {
    const payload = await this.roomRequest<{ roomId: string; result: SyncSummary }>(
      // push 的最长等待是服务端的 pushTimeoutMs（默认 60s），用默认 10s 会把还在推送的请求判死。
      { type: 'room-git-sync', payload: { roomId } }, roomId, 65000)
    return payload.result
  }

  // Git Sync
  async registerRepo(config: Omit<RepoConfig, 'repoId'>): Promise<RepoConfig> {
    const result = await this.request({
      type: 'git-register',
      payload: config
    }) as RepoConfig
    return result
  }

  async syncRepo(repoId: string, operation: 'fetch' | 'pull' | 'push' | 'status', options?: Partial<{ remote: string; branch: string; force: boolean }>): Promise<SyncResult> {
    const result = await this.request({
      type: 'git-sync',
      payload: { repoId, operation, ...options }
    }) as SyncResult
    return result
  }

  requestRepoList(): void {
    this.send({
      type: 'git-repo-list'
    })
  }

  // WebRTC
  async createOffer(targetDeviceId: string): Promise<RTCSessionDescriptionInit> {
    const result = await this.request({
      type: 'webrtc-create-offer',
      targetDeviceId
    }) as RTCSessionDescriptionInit
    return result
  }

  async createAnswer(targetDeviceId: string, offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    const result = await this.request({
      type: 'webrtc-create-answer',
      targetDeviceId,
      payload: { offer }
    }) as RTCSessionDescriptionInit
    return result
  }

  addIceCandidate(targetDeviceId: string, candidate: RTCIceCandidateInit): void {
    this.send({
      type: 'webrtc-candidate',
      targetDeviceId,
      payload: { candidate }
    })
  }
}
