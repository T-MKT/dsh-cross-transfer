/**
 * Cordis module-plugin contract: named `name` / `inject` / `Config` / `apply`
 * exports, matching the harness's own host plugins (see
 * `@deepseek-ai/dsh-host-frontend-static`). The services below register
 * themselves on the context in their constructors.
 *
 * Both `WebServer` and `Context` are imported as types only: the host resolves
 * them from its own tree, so a value import of either would ask for a runtime
 * dependency this package does not carry.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'http'
import type { Duplex } from 'stream'
import { createHash, randomBytes } from 'crypto'
import z from '@deepseek-ai/schemastery'
import { FileTransferService } from './file-transfer.js'
import { ChatService } from './chat.js'
import { GitSyncService } from './git-sync.js'
import { RoomWorkspaceService } from './room-workspace.js'
import type { RoomGitConfig, RoomRepoConfigInput } from './room-workspace.js'
import { RoomService, RoomError, isRoomError, deriveDeviceId, deriveDeviceToken, maskDeviceId, ROOM_ID_MIN_LENGTH, ROOM_ID_MAX_LENGTH } from './rooms.js'
import { WSServer } from './ws-server.js'
import type { ChatMessage } from './chat.js'
import type { RoomConfig, RoomTicket } from './rooms.js'
import type { RoomGate, RoomGateReply, WSSession, WSMessage } from './ws-server.js'

/** Cordis plugin name. */
export const name = 'cross-transfer'

/** The route carrier this plugin mounts onto. */
export const inject = ['webServer']

export interface CrossTransferConfig {
  /** Absolute route prefix, no trailing slash. */
  path: string
  /** Shared secret for device tokens; generated per boot when omitted. */
  tokenSecret?: string
  maxFileSize: number
  chunkSize: number
  /** 房间能力配置；schema 给每一项都配了默认值，旧配置不带 rooms 也能启动。 */
  rooms: RoomConfig
  /**
   * 房间 Git 工作区同步配置（契约 §4.6）；整块可选，旧配置不带 roomGit 也能启动。
   * 形状必须是 RoomGitConfig 而不是 Partial：schema 已经把每一项都补成默认值了，
   * 缺省值的唯一来源是 Config 的 z.object，避免两处默认值漂移。
   */
  roomGit?: RoomGitConfig
}

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  connectedAt: number
  lastActiveAt: number
  sessionCount: number
  capabilities: string[]
}

export interface SessionInfo {
  sessionId: string
  deviceId: string
  deviceName: string
  connectedAt: number
  lastActiveAt: number
}

/** Validated plugin configuration. */
export const Config = z.object({
  path: z.string().default('/api/cross-transfer'),
  tokenSecret: z.string(),
  maxFileSize: z.natural().default(1073741824),
  chunkSize: z.natural().default(1048576),
  rooms: z.object({
    maxRooms: z.natural().default(100),
    maxRoomsPerDevice: z.natural().default(5),
    maxMembersPerRoom: z.natural().default(16),
    roomCodeLength: z.natural().min(4).max(12).default(6),
    minPasswordLength: z.natural().default(6),
    maxJoinAttempts: z.natural().default(8),
    joinAttemptWindowMs: z.natural().default(60000),
    joinLockoutMs: z.natural().default(120000),
    ticketTtlMs: z.natural().default(86400000),
    idleTtlMs: z.natural().default(1800000),
    closeWhenOwnerLeaves: z.boolean().default(true),
    discoverableByDefault: z.boolean().default(true),
    allowRoomList: z.boolean().default(true)
  }).default({}),
  // 契约 §4.6：整块 .default({})，五项各自带默认值。
  // 注意默认值必须与 src/room-workspace.ts 的 DEFAULT_ROOM_GIT_CONFIG 逐项一致。
  roomGit: z.object({
    enabled: z.boolean().default(true),
    debounceMs: z.natural().default(1500),
    pushTimeoutMs: z.natural().default(60000),
    maxBindingsPerRoom: z.natural().default(16),
    maxCandidates: z.natural().default(50)
  }).default({})
})

/** Read a JSON request body, capped to keep a hostile peer from exhausting memory. */
function readJsonBody(req: IncomingMessage, limit = 8 * 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('Request body too large'))
        req.destroy()
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (body.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers?: Record<string, string | number>): void {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
    ...headers
  })
  res.end(text)
}

/** 房号形状与 RoomService.assertRoomId 保持一致，门禁先挡一轮省得垃圾 id 落进服务。 */
const ROOM_ID_PATTERN = new RegExp(`^[0-9]{${ROOM_ID_MIN_LENGTH},${ROOM_ID_MAX_LENGTH}}$`)

/** 路径在房间路由表内而方法不在表内时的统一 405 错误体（§3.2）。 */
const METHOD_NOT_ALLOWED = { error: { code: 'invalid-argument', message: 'Method not allowed' } }

/** RoomErrorCode → HTTP 状态码（§3.3，房间 Git 三项见契约 §4.3）。表外一律 500。 */
const ROOM_ERROR_STATUS: Record<string, number> = {
  'invalid-room-id': 400,
  'invalid-password': 400,
  'invalid-argument': 400,
  'invalid-repo': 400,
  'invalid-workspace': 400,
  'wrong-password': 401,
  'invalid-ticket': 401,
  'invalid-device': 401,
  'not-a-member': 403,
  'forbidden': 403,
  'room-not-found': 404,
  'room-exists': 409,
  'room-full': 409,
  'room-closed': 410,
  'room-locked': 423,
  'too-many-attempts': 429,
  'too-many-rooms': 429,
  // sync-failed 是「同步动作本身抛异常」的兜底码（服务层正常失败只回 ok=false，
  // 契约 §4.3），语义上是「远端不可达」，所以是 502 而不是 500。
  'sync-failed': 502,
  'room-code-exhausted': 503,
  'room-gate-unavailable': 503,
  'internal-error': 500
}

/**
 * 房间/身份路由的统一错误出口：RoomError 按码映射状态码，
 * 其余异常归一成 internal-error，绝不漏到外层的 500 { error: message }。
 */
function respondRoomError(res: ServerResponse, error: unknown): void {
  if (!isRoomError(error)) {
    sendJson(res, 500, {
      error: { code: 'internal-error', message: error instanceof Error ? error.message : String(error) }
    })
    return
  }
  const payload: { code: string; message: string; retryAfterMs?: number } = {
    code: error.code,
    message: error.message
  }
  const headers: Record<string, string | number> = {}
  if (error.code === 'too-many-attempts' && error.retryAfterMs !== undefined) {
    payload.retryAfterMs = error.retryAfterMs
    headers['Retry-After'] = Math.ceil(error.retryAfterMs / 1000)
  }
  sendJson(res, ROOM_ERROR_STATUS[error.code] ?? 500, { error: payload }, headers)
}

/**
 * 消息/请求体里的可选 repo 字段（契约 §4.5）。
 *
 * 只判断「有没有给」：形状与取值一律交给 RoomWorkspaceService 校验（§4.2 规则 2），
 * 门禁不实现第二套规则，否则两处规则必然漂移。null 与 undefined 同义（没给）。
 */
function optionalRepoConfig(value: unknown): RoomRepoConfigInput | undefined {
  if (value === undefined || value === null) return undefined
  return value as RoomRepoConfigInput
}

/**
 * 房间 WS 面的门禁：所有 room-* 与房间语义消息（chat-message / typing 等）都由它裁决。
 *
 * 它按契约本该落在独立的 src/room-gateway.ts；本单元只允许改三个文件，
 * 所以随宿主接线一起放在这里。构造只订阅事件（广播 + chat 桥接），
 * 不调用 server.setRoomGate —— 安装点在 apply() 里，测试里也各自显式安装。
 */
export class RoomGateway implements RoomGate {
  private readonly ctx: Context
  private readonly rooms: RoomService
  private readonly chat: ChatService
  private readonly server: WSServer
  /**
   * 房间 Git 工作区服务（契约 §4.6）。可选：旧调用方（test/ws-server.test.ts 的
   * createRoomHarness）只传 4 个参数，此时所有 Git 相关桥接与 handler 一律退化，
   * 插件其余功能必须照常可用。
   */
  private readonly roomWorkspace?: RoomWorkspaceService
  private readonly offEvents: Array<() => void> = []
  /** 已证明持有 deviceSecret 的设备（真 id）。建房/进房快速通道的前置条件。 */
  private readonly provenDevices = new Set<string>()
  /** 脱敏 id → 真 id。member-joined 事件只带脱敏 id，user-joined 推送需要真 id。 */
  private readonly maskedIndex = new Map<string, string>()

  constructor(ctx: Context, rooms: RoomService, chat: ChatService, server: WSServer, roomWorkspace?: RoomWorkspaceService) {
    this.ctx = ctx
    this.rooms = rooms
    this.chat = chat
    this.server = server
    this.roomWorkspace = roomWorkspace
    this.subscribe()
  }

  /** REST 面验证过 deviceSecret 之后登记：这个真 deviceId 由此获得进房资格。 */
  proveDevice(deviceId: string): void {
    this.provenDevices.add(deviceId)
    this.maskedIndex.set(maskDeviceId(deviceId), deviceId)
  }

  async handle(session: WSSession, message: WSMessage): Promise<RoomGateReply | null> {
    switch (message.type) {
      case 'room-create':
        return this.handleRoomCreate(session, this.assertObject(message.payload))
      case 'room-join':
        return this.handleRoomJoin(session, this.assertObject(message.payload))
      case 'room-leave':
        return this.handleRoomLeave(session, this.assertObject(message.payload))
      case 'room-close':
        return this.handleRoomClose(session, this.assertObject(message.payload))
      case 'room-kick':
        return this.handleRoomKick(session, this.assertObject(message.payload))
      case 'room-password':
        return this.handleRoomPassword(session, this.assertObject(message.payload))
      case 'room-lock':
        return this.handleRoomLock(session, this.assertObject(message.payload))
      case 'room-list':
        return this.handleRoomList()
      case 'room-members':
        return this.handleRoomMembers(session, this.assertObject(message.payload))
      case 'room-git-config':
        return this.handleRoomGitConfig(session, this.assertObject(message.payload))
      case 'room-git-clear':
        return this.handleRoomGitClear(session, this.assertObject(message.payload))
      case 'room-git-status':
        return this.handleRoomGitStatus(session, this.assertObject(message.payload))
      case 'room-workspace-bind':
        return this.handleWorkspaceBind(session, this.assertObject(message.payload))
      case 'room-workspace-unbind':
        return this.handleWorkspaceUnbind(session, this.assertObject(message.payload))
      case 'room-workspace-candidates':
        return this.handleWorkspaceCandidates(session, this.assertObject(message.payload))
      case 'room-git-sync':
        return this.handleRoomGitSync(session, this.assertObject(message.payload))
      case 'chat-message':
        return this.handleChatMessage(session, this.assertObject(message.payload))
      case 'chat-history-request':
        return this.handleChatHistory(session, this.assertObject(message.payload))
      case 'typing':
        return this.handleTyping(session, this.assertObject(message.payload))
      default:
        // 未列出的 room-* 或带 roomId 的自定义类型：绝不放行，也绝不走默认转发。
        throw new RoomError('invalid-argument', `Unsupported room message type: ${message.type}`)
    }
  }

  onSessionClosed(session: WSSession): void {
    const affected = this.rooms.dropSession(session.sessionId, session.deviceId)
    for (const roomId of affected) {
      // dropSession 之后再取快照：刚断开的会话已不在任何成员行上，天然不会收到。
      this.server.broadcastToSessions(this.rooms.getMemberSessionIds(roomId), {
        type: 'user-left',
        deviceId: 'server',
        payload: { roomId, deviceId: session.deviceId, reason: 'disconnected' }
      })
    }
  }

  /** 幂等：执行全部退订函数并清空数组。 */
  dispose(): void {
    for (const off of this.offEvents.splice(0)) off()
  }

  private subscribe(): void {
    // 每个事件只映射一发：房间推送只从这里出去，WS 请求处理器不广播。
    this.offEvents.push(
      this.rooms.on('room-created', room => {
        // 聊天历史按房号落库：房间一存在就开好聊天室，chat-message 才有地方写。
        this.ensureChatRoom(room.roomId, room.name)
      }),
      this.rooms.on('room-closed', (roomId, reason, memberSessionIds) => {
        this.server.broadcastToSessions(memberSessionIds, {
          type: 'room-closed',
          deviceId: 'server',
          payload: { roomId, reason }
        })
        // 契约 §4.2 规则 6：关房必须清掉该房的仓库配置、全部绑定与去抖定时器。
        // 不清的话内存里的明文 token 会一直留到进程退出。
        this.roomWorkspace?.onRoomClosed(roomId)
        // ChatService 没有 dropRoom：关闭房间的聊天历史只能留到进程结束，见 openQuestions。
      }),
      this.rooms.on('member-joined', (roomId, member, memberSessionIds) => {
        // 事件里的 member.deviceId 是脱敏值；user-joined 必须带真 id，客户端靠它跳过自己。
        const deviceId = this.maskedIndex.get(member.deviceId) ?? member.deviceId
        const joinerSessions = new Set(this.server.getDeviceSessions(deviceId).map(s => s.sessionId))
        const recipients = memberSessionIds.filter(id => !joinerSessions.has(id))
        this.server.broadcastToSessions(recipients, {
          type: 'user-joined',
          deviceId: 'server',
          payload: { roomId, deviceId, deviceName: member.deviceName, role: member.role }
        })
      }),
      this.rooms.on('member-left', (roomId, deviceId, reason, memberSessionIds) => {
        this.server.broadcastToSessions(memberSessionIds, {
          type: 'user-left',
          deviceId: 'server',
          payload: { roomId, deviceId, reason }
        })
      }),
      this.rooms.on('member-kicked', (roomId, deviceId, kickedByDeviceId, targetSessionIds, memberSessionIds) => {
        // 被踢者的会话必须单独收到通知（好让自己退出房间），与剩余成员快照取并集去重。
        const recipients = new Set([...targetSessionIds, ...memberSessionIds])
        this.server.broadcastToSessions(recipients, {
          type: 'room-member-kicked',
          deviceId: 'server',
          payload: { roomId, deviceId, kickedByDeviceId }
        })
      }),
      this.rooms.on('owner-changed', (roomId, newOwnerDeviceId, memberSessionIds) => {
        this.server.broadcastToSessions(memberSessionIds, {
          type: 'owner-changed',
          deviceId: 'server',
          payload: { roomId, newOwnerDeviceId }
        })
      }),
      this.rooms.on('password-changed', (roomId, memberSessionIds) => {
        this.server.broadcastToSessions(memberSessionIds, {
          type: 'room-password-changed',
          deviceId: 'server',
          payload: { roomId }
        })
      }),
      this.rooms.on('lock-changed', (roomId, locked, memberSessionIds) => {
        this.server.broadcastToSessions(memberSessionIds, {
          type: 'room-locked',
          deviceId: 'server',
          payload: { roomId, locked }
        })
      }),
      // 聊天广播走 ChatService 的 message 事件：房间成员会话，排除发送会话
      // （发送者自己已经拿到 chat-message-ack，不再收广播）。
      this.chat.on('message', message => {
        this.server.broadcastToSessions(
          this.rooms.getMemberSessionIds(message.roomId),
          { type: 'chat-message', deviceId: 'server', payload: message },
          message.senderSessionId
        )
      })
    )

    // 房间 Git 工作区同步的事件桥接（契约 §4.5）。服务未接线时整段跳过：
    // 既不能报错，也不能让这些事件落进默认的 broadcast 分支。
    if (this.roomWorkspace) {
      const workspace = this.roomWorkspace
      this.offEvents.push(
        workspace.on('status-changed', (roomId) => {
          // 必须按接收者逐个投影（契约 §4.5）：工作区路径只对绑定者本人与房主可见，
          // 同一份 payload 直接广播会把别人的宿主目录发给全房间。
          for (const sessionId of this.rooms.getMemberSessionIds(roomId)) {
            const session = this.server.getSession(sessionId)
            if (!session) continue
            this.server.sendToSession(sessionId, {
              type: 'room-git-status',
              deviceId: 'server',
              payload: workspace.status(roomId, session.deviceId)
            })
          }
        }),
        workspace.on('sync-finished', (roomId, deviceId, result) => {
          // 同步结果不含任何路径，全房间一份 payload 即可。
          this.server.broadcastToSessions(this.rooms.getMemberSessionIds(roomId), {
            type: 'room-git-sync-result',
            deviceId: 'server',
            payload: { roomId, deviceId, result }
          })
        })
      )
    }
    this.ctx.logger.info('[cross-transfer] Room gateway subscribed to room events')
  }

  private ensureChatRoom(roomId: string, name?: string): void {
    if (this.chat.getRoom(roomId)) return
    try {
      this.chat.createRoom(roomId, name ?? 'Room')
    } catch {
      // 并发下已被别处创建：目标已达成。
    }
  }

  // --- validation helpers ---

  private assertObject(payload: unknown): Record<string, unknown> {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new RoomError('invalid-argument', 'Message payload must be an object')
    }
    return payload as Record<string, unknown>
  }

  private assertRoomId(value: unknown): string {
    if (typeof value !== 'string' || !ROOM_ID_PATTERN.test(value)) {
      throw new RoomError('invalid-room-id', `Room id must be ${ROOM_ID_MIN_LENGTH}-${ROOM_ID_MAX_LENGTH} digits`)
    }
    return value
  }

  /**
   * 快速通道的前置条件：这个 deviceId 必须由已登记的 deviceSecret 派生。
   * WS 连接的 token 只证明「会算 sha256」，legacy /token 回落能让自报 deviceId
   * 拿到 token，所以建房/进房必须再看一眼 REST 面登记过的凭据。
   */
  private requireProvenDevice(session: WSSession): void {
    if (!this.provenDevices.has(session.deviceId)) {
      throw new RoomError('invalid-device', 'Device is not registered; call /devices/register first')
    }
  }

  private requireSessionMember(roomId: string, session: WSSession): void {
    if (!this.rooms.isSessionMember(roomId, session.deviceId, session.sessionId)) {
      throw new RoomError('not-a-member', 'This session is not a member of the room')
    }
  }

  /**
   * 取房间 Git 工作区服务（契约 §4.6）。
   *
   * 未接线时（旧调用方只传 4 个构造参数）明确回 room-gate-unavailable，而不是让
   * undefined 上调方法抛 TypeError —— 那会变成 internal-error，掩盖真正的原因。
   */
  private requireRoomWorkspace(): RoomWorkspaceService {
    if (!this.roomWorkspace) {
      throw new RoomError('room-gate-unavailable', 'Room workspace service is not available')
    }
    return this.roomWorkspace
  }

  // --- room lifecycle handlers ---

  private async handleRoomCreate(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    this.requireProvenDevice(session)
    if (typeof payload.password !== 'string') {
      throw new RoomError('invalid-password', 'Password is required')
    }
    // 建房前先做纯校验（契约 §4.5）：校验不过直接回错误，绝不能建出一个半配置的房间。
    const repo = optionalRepoConfig(payload.repo)
    if (repo) this.requireRoomWorkspace().validateRepoConfig(repo)
    const result = await this.rooms.createRoom({
      // 字段的形状与取值范围由 RoomService 校验并归一，这里只透传，避免两处规则漂移。
      roomId: typeof payload.roomId === 'string' ? payload.roomId : undefined,
      name: typeof payload.name === 'string' ? payload.name : undefined,
      password: payload.password,
      maxMembers: typeof payload.maxMembers === 'number' ? payload.maxMembers : undefined,
      discoverable: typeof payload.discoverable === 'boolean' ? payload.discoverable : undefined,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      sessionId: session.sessionId,
      remoteAddress: session.remoteAddress
    })
    if (repo) {
      // 房间已经建好，配置失败不回滚房间：如实把错误回给房主，房间仍可使用。
      const roomId = result.room.roomId
      await this.requireRoomWorkspace().configureRepo(roomId, session.deviceId, repo)
      // 只重新投影 RoomInfo（repoConfigured 在建房那一刻之后才被置位，§3），
      // 应答的三件套形状（room/member/ticket）保持不变，客户端契约不能破。
      return { type: 'room-created', payload: { ...result, room: this.rooms.getRoomInfo(roomId, session.deviceId) } }
    }
    return { type: 'room-created', payload: result }
  }

  private async handleRoomJoin(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    this.requireProvenDevice(session)
    const roomId = this.assertRoomId(payload.roomId)
    if (typeof payload.password !== 'string') {
      throw new RoomError('invalid-password', 'Password is required')
    }
    const result = await this.rooms.joinRoom({
      roomId,
      password: payload.password,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      sessionId: session.sessionId,
      remoteAddress: session.remoteAddress
    })
    return { type: 'room-joined', payload: result }
  }

  private async handleRoomLeave(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    const result = await this.rooms.leaveRoom(roomId, session.deviceId)
    // 契约 §4.5：退房后这个设备的绑定必须清掉，否则它还会按回合结束往房间仓库提交。
    // 异常吞掉：清绑定失败不该让退房本身失败（设备已经不在房间里了）。
    if (this.roomWorkspace) {
      void this.roomWorkspace.unbindWorkspace(roomId, session.deviceId).catch(() => {})
    }
    // leaveRoom 是设备级退房：发起会话拿应答帧，同设备的其它会话由这里补发一帧，
    // 否则残留标签页会停在一个已不属于它的房间里。
    for (const other of this.server.getDeviceSessions(session.deviceId)) {
      if (other.sessionId === session.sessionId) continue
      this.server.sendToSession(other.sessionId, {
        type: 'room-left',
        deviceId: 'server',
        payload: result
      })
    }
    return { type: 'room-left', payload: result }
  }

  private async handleRoomClose(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    // 成员/房主判定交给 RoomService：not-a-member 与 forbidden 的区分它更准。
    await this.rooms.closeRoom(roomId, session.deviceId)
    return { type: 'room-closed', payload: { roomId, reason: 'closed-by-owner' } }
  }

  private async handleRoomKick(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    // 踢人要的是未脱敏的真实 deviceId：成员列表一律脱敏（契约 §1.1），真实 id
    // 由 user-joined / room-member-kicked 等推送语义流转到房主手里。
    if (typeof payload.deviceId !== 'string' || payload.deviceId.length === 0) {
      throw new RoomError('invalid-argument', 'deviceId is required')
    }
    await this.rooms.kickMember(roomId, session.deviceId, payload.deviceId)
    // 契约 §4.5：被踢设备的绑定同样要清掉；异常吞掉，踢人结果已经落定。
    if (this.roomWorkspace) {
      void this.roomWorkspace.unbindWorkspace(roomId, payload.deviceId).catch(() => {})
    }
    return {
      type: 'room-member-kicked',
      payload: { roomId, deviceId: payload.deviceId, kickedByDeviceId: session.deviceId }
    }
  }

  private async handleRoomPassword(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    if (typeof payload.password !== 'string') {
      throw new RoomError('invalid-password', 'Password is required')
    }
    await this.rooms.changePassword(roomId, session.deviceId, payload.password)
    return { type: 'room-password-changed', payload: { roomId } }
  }

  private async handleRoomLock(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    if (typeof payload.locked !== 'boolean') {
      throw new RoomError('invalid-argument', 'locked must be a boolean')
    }
    await this.rooms.setLocked(roomId, session.deviceId, payload.locked)
    return { type: 'room-locked', payload: { roomId, locked: payload.locked } }
  }

  private handleRoomList(): RoomGateReply {
    // 房间列表关闭时 fail-closed：不降级成空列表（空列表会被当成「没有房间」）。
    if (!this.rooms.getConfig().allowRoomList) {
      throw new RoomError('forbidden', 'Room list is disabled')
    }
    return { type: 'room-list', payload: { rooms: this.rooms.listRooms() } }
  }

  private handleRoomMembers(session: WSSession, payload: Record<string, unknown>): RoomGateReply {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    // 成员视图不分视角一律脱敏（契约 §1.1）：房主也不从列表里拿真 id。
    return {
      type: 'room-members',
      payload: { roomId, members: this.rooms.getMembers(roomId, session.deviceId) }
    }
  }

  // --- room git workspace handlers (契约 §4.5) ---

  /**
   * 七个 Git/工作区 handler 的统一形状（契约 §4.5）：
   * assertRoomId → requireSessionMember（门禁只判「这个会话是不是本房成员」）→ 透传给
   * 服务层做权限判定（房主操作由服务层的 isOwner 决定 forbidden）。
   * 参数形状与取值一律交给服务层校验，门禁不重复实现第二套规则。
   */

  private async handleRoomGitConfig(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    const status = await this.requireRoomWorkspace().configureRepo(
      roomId,
      session.deviceId,
      // 没给 repo 时用空对象占位：服务层会把它判成 invalid-repo（remoteUrl is required），
      // 与「显式传了非法值」走同一条错误路径，门禁不必再实现一套形状校验。
      optionalRepoConfig(payload.repo) ?? ({} as RoomRepoConfigInput)
    )
    return { type: 'room-git-status', payload: status }
  }

  private async handleRoomGitClear(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    const status = await this.requireRoomWorkspace().clearRepo(roomId, session.deviceId)
    return { type: 'room-git-status', payload: status }
  }

  private handleRoomGitStatus(session: WSSession, payload: Record<string, unknown>): RoomGateReply {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    return { type: 'room-git-status', payload: this.requireRoomWorkspace().status(roomId, session.deviceId) }
  }

  private async handleWorkspaceBind(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    // path 非字符串时交给服务层报 invalid-workspace（它有 typeof 兜底）。
    const status = await this.requireRoomWorkspace().bindWorkspace(
      roomId,
      session.deviceId,
      typeof payload.path === 'string' ? payload.path : ''
    )
    return { type: 'room-git-status', payload: status }
  }

  private async handleWorkspaceUnbind(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    const status = await this.requireRoomWorkspace().unbindWorkspace(roomId, session.deviceId)
    return { type: 'room-git-status', payload: status }
  }

  private async handleWorkspaceCandidates(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    return { type: 'room-workspace-candidates', payload: { roomId, paths: await this.requireRoomWorkspace().candidates() } }
  }

  private async handleRoomGitSync(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    // 手动同步：trigger 固定 'manual'（契约 §4.2 规则 4，手动 = 用户明确要求，仍要提交）。
    const result = await this.requireRoomWorkspace().sync(roomId, session.deviceId, 'manual')
    return { type: 'room-git-sync-result', payload: { roomId, result } }
  }

  // --- chat handlers ---

  private async handleChatMessage(session: WSSession, payload: Record<string, unknown>): Promise<RoomGateReply> {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    if (typeof payload.content !== 'string' || payload.content.length === 0) {
      throw new RoomError('invalid-argument', 'content must be a non-empty string')
    }
    const type = payload.type === undefined ? 'text' : payload.type
    if (type !== 'text' && type !== 'code' && type !== 'file') {
      throw new RoomError('invalid-argument', 'type must be text, code or file')
    }
    if (payload.metadata !== undefined && (payload.metadata === null || typeof payload.metadata !== 'object')) {
      throw new RoomError('invalid-argument', 'metadata must be an object')
    }
    if (payload.replyTo !== undefined && typeof payload.replyTo !== 'string') {
      throw new RoomError('invalid-argument', 'replyTo must be a string')
    }
    this.rooms.touch(roomId)
    let message: ChatMessage
    try {
      this.ensureChatRoom(roomId)
      message = this.chat.sendMessage({
        roomId,
        senderDeviceId: session.deviceId,
        senderDeviceName: session.deviceName,
        senderSessionId: session.sessionId,
        content: payload.content,
        type,
        metadata: payload.metadata as Record<string, unknown> | undefined,
        replyTo: payload.replyTo as string | undefined
      })
    } catch (error) {
      // ChatService 抛的是普通 Error；把「超长」归一成参数错误，其余照抛（→ internal-error）。
      if (error instanceof Error && error.message === 'Message too long') {
        throw new RoomError('invalid-argument', 'Message too long')
      }
      throw error
    }
    this.rooms.touch(roomId)
    // 广播不在这里做：ChatService 的 message 事件是唯一广播源（见 subscribe）。
    return { type: 'chat-message-ack', payload: message }
  }

  private handleChatHistory(session: WSSession, payload: Record<string, unknown>): RoomGateReply {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    let limit = 100
    if (payload.limit !== undefined) {
      if (typeof payload.limit !== 'number' || !Number.isInteger(payload.limit) || payload.limit < 1 || payload.limit > 1000) {
        throw new RoomError('invalid-argument', 'limit must be an integer between 1 and 1000')
      }
      limit = payload.limit
    }
    return { type: 'chat-history', payload: { roomId, messages: this.chat.getHistory(roomId, limit) } }
  }

  private handleTyping(session: WSSession, payload: Record<string, unknown>): null {
    const roomId = this.assertRoomId(payload.roomId)
    this.requireSessionMember(roomId, session)
    if (typeof payload.isTyping !== 'boolean') {
      throw new RoomError('invalid-argument', 'isTyping must be a boolean')
    }
    this.rooms.touch(roomId)
    this.chat.setTyping(roomId, session.deviceId, session.deviceName, payload.isTyping)
    // 广播在这里做而走不了事件：chat 的 typing 事件不带 sessionId，无法按「排除发送会话」过滤。
    this.server.broadcastToSessions(
      this.rooms.getMemberSessionIds(roomId),
      {
        type: 'typing',
        deviceId: 'server',
        payload: { roomId, deviceId: session.deviceId, deviceName: session.deviceName, isTyping: payload.isTyping }
      },
      session.sessionId
    )
    return null
  }
}

/**
 * Mount the WebSocket carrier and the REST surface.
 * @param ctx - plugin context carrying the `webServer` service.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: CrossTransferConfig): void {
  const path = config.path
  const tokenSecret = config.tokenSecret ?? randomBytes(32).toString('hex')

  const wsServer = new WSServer(ctx)
  const rooms = new RoomService(ctx)
  const fileTransfer = new FileTransferService(ctx)
  const chat = new ChatService(ctx)
  const gitSync = new GitSyncService(ctx)

  wsServer.initialize({ path, tokenSecret, maxFileSize: config.maxFileSize, chunkSize: config.chunkSize })
  fileTransfer.initialize({ maxFileSize: config.maxFileSize, chunkSize: config.chunkSize })
  // chat 必须先于 RoomGateway 初始化：sendMessage 会读 this.config!.maxMessageLength。
  chat.initialize()
  gitSync.initialize()
  rooms.initialize(config.rooms)
  // 房间 Git 工作区服务（契约 §4.6）：必须在 RoomGateway 之前构造好，
  // 因为桥接发生在它的 subscribe() 里（构造函数内）。
  // config.roomGit 可选：旧配置不带这一块时用服务层的默认值。
  const roomWorkspace = new RoomWorkspaceService(ctx, rooms, gitSync)
  roomWorkspace.initialize(config.roomGit ?? {})
  const roomGateway = new RoomGateway(ctx, rooms, chat, wsServer, roomWorkspace)
  // 唯一的门禁安装点：装上之后房间语义消息才会被裁决，否则一律 fail-closed 拒绝。
  wsServer.setRoomGate(roomGateway)

  /** 房间/身份路由共用的票据解析：Bearer 必须是本房间的有效票据。 */
  const requireRoomTicket = (roomId: string, req: IncomingMessage): RoomTicket => {
    const { ticket } = rooms.authenticateBearer(req.headers.authorization, roomId)
    if (!ticket) throw new RoomError('invalid-ticket', 'Room ticket is required')
    return ticket
  }

  /** 房主操作（关闭/改密/锁房）共用的票据解析：票据还必须是 owner 签发的。 */
  const requireOwnerTicket = (roomId: string, req: IncomingMessage): RoomTicket => {
    const ticket = requireRoomTicket(roomId, req)
    if (ticket.role !== 'owner') throw new RoomError('forbidden', 'Only the room owner can do this')
    return ticket
  }

  // WebSocket carrier: one exact-path upgrade route owned by the WS server.
  ctx.effect(
    () =>
      (ctx as Context & { webServer: WebServer }).webServer.registerUpgrade({
        path,
        handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          wsServer.handleUpgrade(req, socket, head)
        }
      }),
    'cross-transfer: websocket upgrade route'
  )

  // REST surface: one prefix route dispatching the documented subpaths.
  ctx.effect(
    () =>
      (ctx as Context & { webServer: WebServer }).webServer.register({
        kind: 'prefix',
        path,
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const route = url.pathname.slice(path.length)
          const webServer = (ctx as Context & { webServer: WebServer }).webServer

          try {
            if (route === '/devices' && req.method === 'GET') {
              sendJson(res, 200, { devices: wsServer.getDevices() })
              return
            }

            if (route === '/sessions' && req.method === 'GET') {
              sendJson(res, 200, { sessions: wsServer.getSessions() })
              return
            }

            if (route === '/devices/register' && req.method === 'POST') {
              try {
                const body = await readJsonBody(req)
                const result = rooms.registerDevice({
                  deviceSecret: typeof body?.deviceSecret === 'string' ? body.deviceSecret : undefined,
                  deviceName: typeof body?.deviceName === 'string' ? body.deviceName : undefined
                })
                // body.tokenSecret 一律忽略：tokenSecret 是宿主配置，不收客户端的。
                const token = deriveDeviceToken(result.deviceId, tokenSecret)
                roomGateway.proveDevice(result.deviceId)
                sendJson(res, 200, { ...result, token })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            if ((route === '/token' || route === '/devices/token') && req.method === 'POST') {
              try {
                const body = await readJsonBody(req)
                const authorization = req.headers.authorization
                const bearer = /^Bearer\s+(.+)$/i.exec(typeof authorization === 'string' ? authorization.trim() : '')
                if (bearer) {
                  // 新流程：凭已登记的 deviceSecret 换 token。body.deviceId 缺省时由 secret 派生。
                  const secret = bearer[1].trim()
                  const deviceId = typeof body?.deviceId === 'string' && body.deviceId.length > 0
                    ? body.deviceId
                    : deriveDeviceId(secret)
                  const credential = rooms.authenticateDevice(secret, deviceId)
                  roomGateway.proveDevice(credential.deviceId)
                  sendJson(res, 200, {
                    token: deriveDeviceToken(credential.deviceId, tokenSecret),
                    deviceId: credential.deviceId
                  })
                  return
                }
                // 旧调用方回落：只为「从未登记过」的自报 deviceId 派生 token。
                // 已登记的 deviceId 是别人的身份——无凭据给它铸票，就能以受害者身份
                // 过 WS token 校验、借成员快速通道免密进房甚至接管房主
                // （test/rooms-security.test.ts 冒充攻击组、test/rooms-limits.test.ts 冒用已登记设备）。
                // 未登记的自报 deviceId 仍放行（旧客户端兼容），但房间操作会被
                // requireProvenDevice 挡住：门禁只认 REST 面验证过 deviceSecret 的设备。
                const deviceId = body?.deviceId
                if (typeof deviceId !== 'string' || deviceId.length === 0) {
                  sendJson(res, 400, { error: 'deviceId required' })
                  return
                }
                if (rooms.hasDeviceId(deviceId)) {
                  throw new RoomError('invalid-device', 'deviceId is already registered; exchange its token with the deviceSecret')
                }
                const token = createHash('sha256').update(`${deviceId}:${tokenSecret}`).digest('hex')
                sendJson(res, 200, { token, deviceId })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            if (route === '/rooms/create' && req.method === 'POST') {
              try {
                const body = await readJsonBody(req)
                const { credential } = rooms.authenticateBearer(req.headers.authorization)
                if (!credential) throw new RoomError('invalid-device', 'Device secret is required')
                roomGateway.proveDevice(credential.deviceId)
                // 建房前先做纯校验（契约 §4.5）：校验不过直接回错误，绝不能建出一个半配置的房间。
                const repo = optionalRepoConfig(body?.repo)
                if (repo) roomWorkspace.validateRepoConfig(repo)
                const result = await rooms.createRoom({
                  roomId: typeof body?.roomId === 'string' ? body.roomId : undefined,
                  name: typeof body?.name === 'string' ? body.name : undefined,
                  password: body?.password,
                  maxMembers: typeof body?.maxMembers === 'number' ? body.maxMembers : undefined,
                  discoverable: typeof body?.discoverable === 'boolean' ? body.discoverable : undefined,
                  deviceId: credential.deviceId,
                  deviceName: credential.deviceName,
                  remoteAddress: req.socket.remoteAddress ?? undefined
                })
                // 与 WS room-create 一致（契约 §4.5）：建房成功后配置仓库并重新投影
                // RoomInfo（否则应答里的 repoConfigured 仍是建房那一刻的 false）。
                // 应答仍返回完整 RoomJoinResult，只有 room 换成最新投影。
                if (repo) {
                  const roomId = result.room.roomId
                  await roomWorkspace.configureRepo(roomId, credential.deviceId, repo)
                  sendJson(res, 200, { ...result, room: rooms.getRoomInfo(roomId, credential.deviceId) })
                  return
                }
                sendJson(res, 200, result)
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            if (route === '/rooms/join' && req.method === 'POST') {
              try {
                const body = await readJsonBody(req)
                if (typeof body?.deviceSecret !== 'string' || body.deviceSecret.length === 0) {
                  throw new RoomError('invalid-device', 'Device secret is required')
                }
                const credential = rooms.authenticateDevice(body.deviceSecret, deriveDeviceId(body.deviceSecret))
                roomGateway.proveDevice(credential.deviceId)
                const result = await rooms.joinRoom({
                  roomId: body?.roomId,
                  password: body?.password,
                  deviceId: credential.deviceId,
                  deviceName: typeof body?.deviceName === 'string' && body.deviceName.length > 0
                    ? body.deviceName
                    : credential.deviceName,
                  remoteAddress: req.socket.remoteAddress ?? undefined
                })
                sendJson(res, 200, result)
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            if (route === '/rooms') {
              if (req.method !== 'GET') {
                sendJson(res, 405, METHOD_NOT_ALLOWED)
                return
              }
              try {
                if (!rooms.getConfig().allowRoomList) {
                  throw new RoomError('forbidden', 'Room list is disabled')
                }
                sendJson(res, 200, { rooms: rooms.listRooms() })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            // /rooms/:roomId 系列：先按路径、再按方法；未列出的子路径落到底部 404。
            const detailMatch = /^\/rooms\/([0-9]{4,12})$/.exec(route)
            if (detailMatch) {
              const roomId = detailMatch[1]
              if (req.method !== 'GET') {
                sendJson(res, 405, METHOD_NOT_ALLOWED)
                return
              }
              try {
                const ticket = requireRoomTicket(roomId, req)
                sendJson(res, 200, { room: rooms.getRoomInfo(roomId, ticket.deviceId) })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            const subMatch = /^\/rooms\/([0-9]{4,12})\/(members|close|password|lock)$/.exec(route)
            if (subMatch) {
              const [, roomId, sub] = subMatch
              if (sub === 'members') {
                if (req.method !== 'GET') {
                  sendJson(res, 405, METHOD_NOT_ALLOWED)
                  return
                }
                try {
                  const ticket = requireRoomTicket(roomId, req)
                  sendJson(res, 200, { roomId, members: rooms.getMembers(roomId, ticket.deviceId) })
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, METHOD_NOT_ALLOWED)
                return
              }
              if (sub === 'close') {
                try {
                  const ticket = requireOwnerTicket(roomId, req)
                  await readJsonBody(req)
                  await rooms.closeRoom(roomId, ticket.deviceId)
                  sendJson(res, 200, { roomId, closed: true })
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (sub === 'password') {
                try {
                  const ticket = requireOwnerTicket(roomId, req)
                  const body = await readJsonBody(req)
                  if (typeof body?.password !== 'string') {
                    throw new RoomError('invalid-password', 'Password is required')
                  }
                  await rooms.changePassword(roomId, ticket.deviceId, body.password)
                  sendJson(res, 200, { roomId, changed: true })
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              // sub === 'lock'
              try {
                const ticket = requireOwnerTicket(roomId, req)
                const body = await readJsonBody(req)
                if (typeof body?.locked !== 'boolean') {
                  throw new RoomError('invalid-argument', 'locked must be a boolean')
                }
                await rooms.setLocked(roomId, ticket.deviceId, body.locked)
                sendJson(res, 200, { roomId, locked: body.locked })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            const memberMatch = /^\/rooms\/([0-9]{4,12})\/members\/([^/]+)$/.exec(route)
            if (memberMatch) {
              const [, roomId, targetDeviceId] = memberMatch
              if (req.method !== 'DELETE') {
                sendJson(res, 405, METHOD_NOT_ALLOWED)
                return
              }
              try {
                const ticket = requireRoomTicket(roomId, req)
                // REST 只支持自助退房：路径 deviceId 必须就是票据持有者。房主踢人必须走
                // WS room-kick——成员列表对非房主是脱敏的，REST 拿不到可比对的真实 id。
                if (targetDeviceId !== ticket.deviceId) {
                  throw new RoomError('forbidden', 'REST member removal only supports leaving the room yourself')
                }
                const result = await rooms.leaveRoom(roomId, ticket.deviceId)
                sendJson(res, 200, { roomId, deviceId: ticket.deviceId, removed: result.removed, self: true })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            // 房间 Git 工作区同步路由（契约 §4.4）：位置在房间路由段之后、404 之前。
            // 方法不匹配统一 405，错误体一律走 respondRoomError。
            const gitMatch = /^\/rooms\/([0-9]{4,12})\/(git|workspace|workspaces)$/.exec(route)
            if (gitMatch) {
              const [, roomId, sub] = gitMatch
              if (sub === 'git' && req.method === 'GET') {
                try {
                  const ticket = requireRoomTicket(roomId, req)
                  sendJson(res, 200, roomWorkspace.status(roomId, ticket.deviceId))
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (sub === 'git' && req.method === 'PUT') {
                try {
                  const ticket = requireOwnerTicket(roomId, req)
                  const body = await readJsonBody(req)
                  sendJson(res, 200, await roomWorkspace.configureRepo(roomId, ticket.deviceId, body as RoomRepoConfigInput))
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (sub === 'git' && req.method === 'DELETE') {
                try {
                  const ticket = requireOwnerTicket(roomId, req)
                  sendJson(res, 200, await roomWorkspace.clearRepo(roomId, ticket.deviceId))
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (sub === 'workspace' && req.method === 'PUT') {
                try {
                  const ticket = requireRoomTicket(roomId, req)
                  const body = await readJsonBody(req)
                  if (typeof body?.path !== 'string' || body.path.length === 0) {
                    throw new RoomError('invalid-workspace', 'path is required')
                  }
                  sendJson(res, 200, await roomWorkspace.bindWorkspace(roomId, ticket.deviceId, body.path))
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (sub === 'workspace' && req.method === 'DELETE') {
                try {
                  const ticket = requireRoomTicket(roomId, req)
                  sendJson(res, 200, await roomWorkspace.unbindWorkspace(roomId, ticket.deviceId))
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              if (sub === 'workspaces' && req.method === 'GET') {
                try {
                  const ticket = requireRoomTicket(roomId, req)
                  sendJson(res, 200, { roomId, paths: await roomWorkspace.candidates() })
                } catch (error) {
                  respondRoomError(res, error)
                }
                return
              }
              sendJson(res, 405, METHOD_NOT_ALLOWED)
              return
            }

            const gitSyncMatch = /^\/rooms\/([0-9]{4,12})\/git\/sync$/.exec(route)
            if (gitSyncMatch) {
              const [, roomId] = gitSyncMatch
              if (req.method !== 'POST') {
                sendJson(res, 405, METHOD_NOT_ALLOWED)
                return
              }
              try {
                const ticket = requireRoomTicket(roomId, req)
                // 手动同步：trigger 固定 'manual'（契约 §4.2 规则 4）。
                sendJson(res, 200, { roomId, result: await roomWorkspace.sync(roomId, ticket.deviceId, 'manual') })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            if (route === '/files/initiate' && req.method === 'POST') {
              const body = await readJsonBody(req)
              sendJson(res, 200, await fileTransfer.initiateTransfer(body))
              return
            }

            if (route === '/chat/history' && req.method === 'GET') {
              try {
                const roomId = url.searchParams.get('roomId') ?? 'default'
                const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '100', 10)
                const limit = Number.isFinite(limitRaw) ? limitRaw : 100
                const ticket = requireRoomTicket(roomId, req)
                if (!rooms.isMember(roomId, ticket.deviceId)) {
                  throw new RoomError('not-a-member', 'Not a member of this room')
                }
                sendJson(res, 200, { roomId, messages: chat.getHistory(roomId, limit) })
              } catch (error) {
                respondRoomError(res, error)
              }
              return
            }

            if (route === '/git/repos' && req.method === 'GET') {
              sendJson(res, 200, { repos: gitSync.getRepos() })
              return
            }

            if (route === '/git/repos' && req.method === 'POST') {
              sendJson(res, 200, await gitSync.registerRepo(await readJsonBody(req)))
              return
            }

            if (route === '/git/sync' && req.method === 'POST') {
              const body = await readJsonBody(req)
              sendJson(res, 200, await gitSync.syncRepo(body?.repoId, body?.options))
              return
            }

            sendJson(res, 404, { error: 'Not found' })
          } catch (error) {
            sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
          }
          void webServer
        }
      }),
    'cross-transfer: rest routes'
  )

  // 宿主钩子（契约 §4.6）：AI 回合结束 → 房间绑定工作区提交+推送。
  // 宿主没有 workspaceChanges 服务时 attachHost 只记一条 info 并返回空退订函数，
  // 插件其余功能照常可用（契约 §4.2 attachHost）。
  const detachHost = roomWorkspace.attachHost()

  // One effect owns the whole teardown: services stop when the fiber unloads.
  ctx.effect(() => () => {
    // 先摘门禁再拆服务：拆机过程中不再有房间帧落到已经关掉的服务上。
    wsServer.setRoomGate(null)
    roomGateway.dispose()
    wsServer.shutdown()
    fileTransfer.shutdown()
    chat.shutdown()
    gitSync.shutdown()
    rooms.shutdown()
    // 契约 §4.6：先退订宿主钩子再关服务——顺序反了会在关闭瞬间又触发一次同步。
    detachHost()
    roomWorkspace.shutdown()
  }, 'cross-transfer: service teardown')

  ctx.logger.info(`[cross-transfer] mounted at ${path} (rooms enabled)`)
}

export default { name, inject, Config, apply }
