/**
 * Room service: room lifecycle, password gate, membership, tickets and
 * per-device credentials.
 *
 * Design notes (the "why" behind the shape):
 * - Passwords are scrypt-hashed with a per-room salt; the plaintext only ever
 *   exists inside the create/join argument objects. Nothing derived from the
 *   hash is ever projected outward.
 * - Device identity is derived FROM a secret the client holds, never reported
 *   by the client. A self-declared deviceId alone must never unlock the
 *   "already a member" fast path, otherwise guessing an id would be a
 *   zero-cost room takeover.
 * - Every read that leaves this service goes through maskDeviceId, so the
 *   outward projection cannot be used to enumerate real device ids.
 */
import { Service, Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes, randomInt, scrypt as scryptCallback, timingSafeEqual } from 'crypto'
import { promisify } from 'util'
import { createTypedEmitter, TypedEmitter } from './typed-emitter.js'

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem?: number }
) => Promise<Buffer>

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type RoomRole = 'owner' | 'member'
/** 房号：4~12 位纯数字字符串 */
export type RoomId = string
/** 设备身份凭据（256-bit hex）。客户端自存、服务端只认它，deviceId 由它派生 */
export type DeviceSecret = string

/**
 * 房间的公开投影。不含 sessionId、不含票据、不含任何凭据。
 * ownerDeviceId 在对外投影里必须脱敏（见 maskDeviceId），因为它不是凭据但也不该被枚举。
 */
export interface RoomInfo {
  roomId: RoomId
  name: string
  /** 脱敏房主设备 id（前 4 + '…' + 后 4）。用于 UI 判断「我是不是房主」，不是授权依据 */
  ownerDeviceId: string
  /** 房主当前是否有活会话 */
  ownerOnline: boolean
  createdAt: number
  lastActivityAt: number
  /** 成员行数，含离线但保留席位的成员 */
  memberCount: number
  maxMembers: number
  locked: boolean
  discoverable: boolean
}

/** 成员视图。deviceId 同样脱敏；sessionIds 集合永不外泄，只暴露计数与在线位。 */
export interface RoomMember {
  deviceId: string
  deviceName: string
  role: RoomRole
  joinedAt: number
  sessionCount: number
  online: boolean
}

/** 票据的服务端记录 */
export interface RoomTicket {
  ticket: string
  roomId: RoomId
  deviceId: string
  role: RoomRole
  issuedAt: number
  expiresAt: number
}

export type RoomCloseReason = 'closed-by-owner' | 'idle-timeout' | 'owner-left'
/** 只描述非惩罚性离开；被踢走 member-kicked 事件 */
export type RoomLeaveReason = 'left' | 'disconnected'

export interface DeviceCredential {
  deviceSecret: string
  deviceId: string
  deviceName: string
  createdAt: number
  lastSeenAt: number
}

export interface DeviceRegisterRequest {
  /** 首次登记时省略；服务端铸一个新 secret 并返回 */
  deviceSecret?: DeviceSecret
  deviceName?: string
}

export interface DeviceRegisterResult {
  deviceId: string
  deviceSecret: DeviceSecret
  deviceName: string
  /** 与 deviceId+tokenSecret 对应的连接 token，免再调一次 /token */
  token: string
}

export type RoomErrorCode =
  // 房间
  | 'room-not-found' | 'room-exists' | 'room-closed' | 'room-full' | 'room-locked'
  | 'too-many-rooms' | 'room-code-exhausted'
  // 参数与凭据
  | 'invalid-room-id' | 'invalid-password' | 'invalid-argument' | 'wrong-password' | 'invalid-ticket'
  // 身份与授权
  | 'invalid-device'      // deviceSecret 缺失/未登记（客户端凭据问题）
  | 'too-many-attempts'   // 试错锁定，必带 retryAfterMs
  | 'not-a-member'        // 不是该房间成员，或该会话未挂在该成员上
  | 'forbidden'           // 是成员但非房主 / 房主踢自己 / 房间列表关闭
  // 传输层
  | 'room-gate-unavailable' | 'internal-error'

export class RoomError extends Error {
  readonly code: RoomErrorCode
  readonly retryAfterMs?: number

  constructor(code: RoomErrorCode, message: string, options?: { retryAfterMs?: number }) {
    super(message)
    this.name = 'RoomError'
    this.code = code
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
  }
}

export function isRoomError(value: unknown): value is RoomError {
  return value instanceof RoomError
}

export interface RoomConfig {
  maxRooms: number
  maxRoomsPerDevice: number
  maxMembersPerRoom: number
  roomCodeLength: number
  minPasswordLength: number
  maxJoinAttempts: number
  joinAttemptWindowMs: number
  joinLockoutMs: number
  ticketTtlMs: number
  idleTtlMs: number
  closeWhenOwnerLeaves: boolean
  discoverableByDefault: boolean
  allowRoomList: boolean
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  maxRooms: 100,
  maxRoomsPerDevice: 5,
  maxMembersPerRoom: 16,
  roomCodeLength: 6,
  minPasswordLength: 6,
  maxJoinAttempts: 8,
  joinAttemptWindowMs: 60_000,
  joinLockoutMs: 120_000,
  ticketTtlMs: 86_400_000,
  idleTtlMs: 1_800_000,
  closeWhenOwnerLeaves: true,
  discoverableByDefault: true,
  allowRoomList: true
}

export const ROOM_ID_MIN_LENGTH = 4
export const ROOM_ID_MAX_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 128
export const CREATE_RESERVATION_TTL_MS = 30_000
export const ROOM_CODE_MAX_ATTEMPTS = 20

/** scrypt 参数。固定值（不进 RoomConfig），但测试可经 setScryptParams 调低以跑得快。 */
const DEFAULT_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }
const SCRYPT_KEYLEN = 64
const SCRYPT_SALT_BYTES = 16
/**
 * Node 的 scrypt 会剥掉输入末尾的全部 NUL 字节（string 与 Buffer 一视同仁），
 * 「password + \u0000」会与 password 哈希出同一个值，比对就不再精确到整个字符串。
 * 输入末尾恒定拼一个非 NUL 哨兵字节做域分隔：有哨兵在，任何尾随 NUL 都变成
 * 嵌入字节被保留，两个不同的字符串再也不可能哈希出同一个值。
 */
const PASSWORD_SENTINEL = '\u0001'
/** scrypt 的内存上限必须放开，否则 N=16384/r=8 会撞上 node 默认 32MB。 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024
/** 凭据登记表上限，只留最近活跃的。 */
const MAX_CREDENTIALS = 10_000
const CREDENTIAL_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface RoomEvents {
  'room-created': [room: RoomInfo, memberSessionIds: string[]]
  'room-closed': [roomId: RoomId, reason: RoomCloseReason, memberSessionIds: string[]]
  'member-joined': [roomId: RoomId, member: RoomMember, memberSessionIds: string[]]
  'member-left': [roomId: RoomId, deviceId: string, reason: RoomLeaveReason, memberSessionIds: string[]]
  'member-kicked': [roomId: RoomId, deviceId: string, kickedByDeviceId: string, targetSessionIds: string[], memberSessionIds: string[]]
  'owner-changed': [roomId: RoomId, newOwnerDeviceId: string, memberSessionIds: string[]]
  'password-changed': [roomId: RoomId, memberSessionIds: string[]]
  'lock-changed': [roomId: RoomId, locked: boolean, memberSessionIds: string[]]
}

export interface CreateRoomRequest {
  roomId?: RoomId
  name?: string
  password: string
  maxMembers?: number
  discoverable?: boolean
  deviceId: string
  deviceName: string
  sessionId?: string
  remoteAddress?: string
}

export interface JoinRoomRequest {
  roomId: RoomId
  password: string
  deviceId: string
  deviceName: string
  sessionId?: string
  remoteAddress?: string
}

export interface RoomJoinResult {
  room: RoomInfo
  member: RoomMember
  ticket: RoomTicket
}

export interface RoomLeaveResult {
  roomId: RoomId
  deviceId: string
  /** 成员行是否被移除（显式退房 true；仅会话断开 false） */
  removed: boolean
  /** closeWhenOwnerLeaves=true 且房主退房 */
  closed: boolean
  newOwnerDeviceId?: string
}

// ---------------------------------------------------------------------------
// identity helpers
// ---------------------------------------------------------------------------

/** deviceId = sha256('xfer-device:' + secret).slice(0, 16)。secret 是 32 字节 hex。 */
export function deriveDeviceId(secret: DeviceSecret): string {
  return createHash('sha256').update(`xfer-device:${secret}`).digest('hex').slice(0, 16)
}

/** token = sha256(deviceId + ':' + tokenSecret)，与 ws-server.validateToken 完全一致 */
export function deriveDeviceToken(deviceId: string, tokenSecret: string): string {
  return createHash('sha256').update(`${deviceId}:${tokenSecret}`).digest('hex')
}

/** 将 deviceId 脱敏：对外投影/列表/广播统一用它。长度 < 8 时整体打码为 '***' */
export function maskDeviceId(deviceId: string): string {
  if (deviceId.length < 8) return '***'
  return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`
}

/** 32 字节 hex；256-bit 秘密。 */
function newDeviceSecret(): DeviceSecret {
  return randomBytes(32).toString('hex')
}

/** 纯数字房号，长度在契约区间内。用于房主自定房号与随机房号生成。 */
function generateRoomCode(length: number): RoomId {
  const min = 10 ** (length - 1)
  const max = 10 ** length
  // randomInt 上界是开区间，所以直接传 10**length。
  return String(randomInt(min, max))
}

// ---------------------------------------------------------------------------
// internal records
// ---------------------------------------------------------------------------

interface MemberRecord {
  deviceId: string
  deviceName: string
  role: RoomRole
  joinedAt: number
  sessionIds: Set<string>
  online: boolean
}

interface RoomRecord {
  info: RoomInfo
  /** 真值，不对外；info.ownerDeviceId 是它的脱敏 */
  realOwnerDeviceId: string
  /** null = 建房占位，对所有人等同不存在 */
  passwordHash: string | null
  /** 正在做密码校验的 deviceId（容量预留） */
  pendingMembers: Set<string>
  members: Map<string, MemberRecord>
  tickets: Set<string>
  /** 房主最后一个会话丢失的时间；房主上线/移交/建房时置 null */
  ownerOfflineSince: number | null
  createdAt: number
}

/** 密码哈希参数快照，随每条哈希一起存，便于将来升级参数而不作废旧房间。 */
interface ScryptParams { N: number; r: number; p: number }

export class RoomService extends Service {
  private config: RoomConfig = { ...DEFAULT_ROOM_CONFIG }
  private scryptParams: ScryptParams = { ...DEFAULT_SCRYPT_PARAMS }
  private rooms = new Map<RoomId, RoomRecord>()
  private credentials = new Map<DeviceSecret, DeviceCredential>()
  private tickets = new Map<string, RoomTicket>()
  private createReservations = new Map<RoomId, number>()
  private sessionRooms = new Map<string, Set<RoomId>>()
  private closedRooms = new Map<RoomId, { closedAt: number; reason: RoomCloseReason }>()
  private failureWindows = new Map<string, number[]>()
  private lockouts = new Map<string, { until: number; reason: 'attempts' | 'lock' }>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private emitter = createTypedEmitter<RoomEvents>()

  constructor(ctx: Context) {
    super(ctx, 'rooms')
  }

  // TypedEmitter methods
  on<K extends keyof RoomEvents>(event: K, listener: (...args: RoomEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof RoomEvents>(event: K, listener: (...args: RoomEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof RoomEvents>(event: K, ...args: RoomEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof RoomEvents>(event: K, listener: (...args: RoomEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  initialize(config: Partial<RoomConfig> = {}): void {
    this.config = { ...DEFAULT_ROOM_CONFIG, ...config }
    const period = Math.max(1000, Math.min(60_000, this.config.idleTtlMs / 4))
    this.sweepTimer = setInterval(() => this.runMaintenance(), period)
    // 回收 tick 不应该拖着进程不放。
    this.sweepTimer.unref?.()
    this.ctx.logger.info('[cross-transfer] Room service initialized')
  }

  shutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.rooms.clear()
    this.credentials.clear()
    this.tickets.clear()
    this.createReservations.clear()
    this.sessionRooms.clear()
    this.closedRooms.clear()
    this.failureWindows.clear()
    this.lockouts.clear()
    this.ctx.logger.info('[cross-transfer] Room service shut down')
  }

  /** 当前配置的浅拷贝，只读用。 */
  getConfig(): RoomConfig {
    return { ...this.config }
  }

  // -------------------------------------------------------------------------
  // devices
  // -------------------------------------------------------------------------

  /**
   * 登记或凭已有 secret 取回身份。
   * 未登记 + 无 secret → invalid-device（调用方应先走 /devices/register）。
   */
  registerDevice(request: DeviceRegisterRequest): DeviceRegisterResult {
    const requested = typeof request?.deviceSecret === 'string' ? request.deviceSecret.trim() : ''
    let secret = requested
    let credential = requested ? this.credentials.get(requested) : undefined

    if (!credential) {
      // 调用方给了 secret 但服务端没登记过：拒绝，不能就地铸一个撞上已有 deviceId 的身份。
      if (requested) {
        throw new RoomError('invalid-device', 'Device secret is not registered')
      }
      secret = newDeviceSecret()
      credential = {
        deviceSecret: secret,
        deviceId: deriveDeviceId(secret),
        deviceName: this.normalizeDeviceName(request?.deviceName, undefined),
        createdAt: Date.now(),
        lastSeenAt: Date.now()
      }
      this.credentials.set(secret, credential)
      this.evictCredentials()
    } else {
      credential.lastSeenAt = Date.now()
      if (request?.deviceName) credential.deviceName = this.normalizeDeviceName(request.deviceName, credential.deviceName)
      // 让 Map 的插入顺序反映最近使用，淘汰时才有意义。
      this.credentials.delete(secret)
      this.credentials.set(secret, credential)
    }

    return {
      deviceId: credential.deviceId,
      deviceSecret: credential.deviceSecret,
      deviceName: credential.deviceName,
      // tokenSecret 属于宿主配置，由调用方（REST 面）补齐；这里给 deviceId 派生值。
      token: ''
    }
  }

  /** 解析并刷新 lastSeenAt；未登记 → invalid-device */
  authenticateDevice(deviceSecret: DeviceSecret | undefined, deviceId: string): DeviceCredential {
    if (typeof deviceSecret !== 'string' || deviceSecret.length === 0) {
      throw new RoomError('invalid-device', 'Device secret is required')
    }
    const credential = this.credentials.get(deviceSecret)
    if (!credential) {
      throw new RoomError('invalid-device', 'Device secret is not registered')
    }
    if (credential.deviceId !== deviceId) {
      // secret 与自报 deviceId 必须一致：deviceId 由 secret 派生，不由调用方决定。
      throw new RoomError('invalid-device', 'Device secret does not match device id')
    }
    credential.lastSeenAt = Date.now()
    return credential
  }

  /**
   * 该 deviceId 是否已被登记为凭据。凭据表以 deviceSecret 为键，这里按值扫一遍：
   * 只在 legacy token 回落这类低频路径上调用。legacy 回落必须拒掉已登记的
   * deviceId——已登记 id 是别人的身份，无凭据给它铸连接 token 就等于冒充
   * 已登记成员/房主（deviceId 本身在系统内不是秘密，可经设备列表或广播枚举到）。
   */
  hasDeviceId(deviceId: string): boolean {
    for (const credential of this.credentials.values()) {
      if (credential.deviceId === deviceId) return true
    }
    return false
  }

  private normalizeDeviceName(name: string | undefined, fallback: string | undefined): string {
    const value = typeof name === 'string' ? name.trim() : ''
    if (value.length > 0) return value.slice(0, 64)
    return fallback ?? `Device-${randomBytes(3).toString('hex')}`
  }

  private evictCredentials(): void {
    const now = Date.now()
    for (const [secret, credential] of this.credentials) {
      if (this.credentials.size <= MAX_CREDENTIALS) break
      if (now - credential.lastSeenAt > CREDENTIAL_TTL_MS) this.credentials.delete(secret)
    }
    // Map 顺序即 LRU 顺序（读取时会重排），超限就从最久未用的开始丢。
    while (this.credentials.size > MAX_CREDENTIALS) {
      const oldest = this.credentials.keys().next().value
      if (oldest === undefined) break
      this.credentials.delete(oldest)
    }
  }

  // -------------------------------------------------------------------------
  // create / join
  // -------------------------------------------------------------------------

  async createRoom(request: CreateRoomRequest): Promise<RoomJoinResult> {
    const now = Date.now()
    const password = this.assertPassword(request?.password)
    const deviceId = request.deviceId
    const deviceName = this.normalizeDeviceName(request?.deviceName, undefined)

    // 同步段：校验 + 上限判定 + 房号占用判定，全部先做完再 await，
    // 否则并发建房会同时通过检查。
    this.pruneReservations(now)
    this.pruneClosedRooms()
    const roomId = request?.roomId !== undefined
      ? this.assertCustomRoomId(request.roomId)
      : this.pickRandomRoomId()

    if (this.rooms.has(roomId) || this.createReservations.has(roomId)) {
      throw new RoomError('room-exists', 'Room already exists')
    }
    if (this.occupiedRoomCount() >= this.config.maxRooms) {
      throw new RoomError('too-many-rooms', 'Too many rooms')
    }
    if (this.ownedRoomCount(deviceId) >= this.config.maxRoomsPerDevice) {
      throw new RoomError('too-many-rooms', 'Too many rooms for this device')
    }

    const maxMembers = this.normalizeMaxMembers(request?.maxMembers)
    const record: RoomRecord = {
      info: {
        roomId,
        name: this.normalizeRoomName(request?.name),
        ownerDeviceId: maskDeviceId(deviceId),
        ownerOnline: true,
        createdAt: now,
        lastActivityAt: now,
        memberCount: 0,
        maxMembers,
        locked: false,
        discoverable: request?.discoverable !== undefined
          ? Boolean(request.discoverable)
          : this.config.discoverableByDefault
      },
      realOwnerDeviceId: deviceId,
      passwordHash: null,
      pendingMembers: new Set(),
      members: new Map(),
      tickets: new Set(),
      ownerOfflineSince: null,
      createdAt: now
    }
    // 占位：对 listRooms/getRoomInfo/joinRoom 等同不存在，但 hasRoom/getRoomCount 算它占用。
    this.rooms.set(roomId, record)
    this.createReservations.set(roomId, now + CREATE_RESERVATION_TTL_MS)

    let hash: string
    try {
      hash = await this.hashPassword(password)
    } catch (error) {
      this.rooms.delete(roomId)
      this.createReservations.delete(roomId)
      this.ctx.logger.warn('[cross-transfer] Room creation failed while hashing:', error)
      throw new RoomError('internal-error', 'Failed to create room')
    }

    // 占位可能已被 tick 清掉（超龄），那种情况下房间等于从未存在。
    if (this.rooms.get(roomId) !== record) {
      this.createReservations.delete(roomId)
      throw new RoomError('internal-error', 'Room creation reservation expired')
    }

    record.passwordHash = hash
    this.createReservations.delete(roomId)

    const member: MemberRecord = {
      deviceId,
      deviceName,
      role: 'owner',
      joinedAt: now,
      sessionIds: new Set(),
      online: false
    }
    record.members.set(deviceId, member)
    if (request.sessionId) this.attachSession(record, member, request.sessionId)
    record.ownerOfflineSince = member.sessionIds.size > 0 ? null : Date.now()
    this.refreshCounts(record)
    this.clearFailures(deviceId, roomId, request.remoteAddress)
    const ticket = this.issueTicket(record, deviceId, 'owner')

    this.emit('room-created', this.projectRoom(record), this.memberSessionIds(record))

    return { room: this.projectRoom(record), member: this.projectMember(record, member), ticket }
  }

  async joinRoom(request: JoinRoomRequest): Promise<RoomJoinResult> {
    const now = Date.now()
    const password = this.assertPassword(request?.password)
    const deviceId = request.deviceId
    const deviceName = this.normalizeDeviceName(request?.deviceName, undefined)

    // 1. roomId 形状
    const roomId = this.assertRoomId(request?.roomId)

    // 2. 成员快速通道。前置条件由调用方保证：deviceId 必须由已登记的凭据派生
    // （WS 面 = 连接时的 token 校验；REST 面 = authenticateDevice）。
    const fastRoom = this.rooms.get(roomId)
    if (fastRoom && fastRoom.passwordHash !== null && fastRoom.members.has(deviceId)) {
      const member = fastRoom.members.get(deviceId)!
      member.deviceName = deviceName
      if (request.sessionId) this.attachSession(fastRoom, member, request.sessionId)
      // 房主重连即视为上线。
      if (member.role === 'owner') fastRoom.ownerOfflineSince = null
      fastRoom.info.lastActivityAt = now
      this.refreshCounts(fastRoom)
      // 只清这个设备自己的失败计数：快速通道没有验证任何密码，若顺手动共享的
      // ip:<roomId>:<addr> 桶，同 IP 上被锁定的爆破者就能借在房成员的一次免密
      // 回房无限续杯（test/rooms-security.test.ts 限流重置组）。
      this.clearFailures(deviceId, roomId, request.remoteAddress, 'device-only')
      const ticket = this.issueTicket(fastRoom, deviceId, member.role)
      return { room: this.projectRoom(fastRoom), member: this.projectMember(fastRoom, member), ticket }
    }

    // 3. 限流锁定（先于存在性检查，否则错误码差异就是房号枚举器）
    this.assertNotLocked(deviceId, roomId, request.remoteAddress, now)

    // 4. 房间不存在
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      this.recordFailure(deviceId, roomId, request.remoteAddress, now)
      const tombstone = this.closedRooms.get(roomId)
      if (tombstone) throw new RoomError('room-closed', 'Room is closed')
      throw new RoomError('room-not-found', 'Room not found')
    }

    // 5. 已锁
    if (record.info.locked) {
      this.recordFailure(deviceId, roomId, request.remoteAddress, now)
      throw new RoomError('room-locked', 'Room is locked')
    }

    // 6. 容量（含正在校验的预留），先同步占位再 await
    if (record.members.size + record.pendingMembers.size >= record.info.maxMembers) {
      this.recordFailure(deviceId, roomId, request.remoteAddress, now)
      throw new RoomError('room-full', 'Room is full')
    }
    record.pendingMembers.add(deviceId)

    try {
      // 7. 密码比对
      const matches = await this.verifyPassword(password, record.passwordHash)
      if (!matches) {
        this.recordFailure(deviceId, roomId, request.remoteAddress, now)
        throw new RoomError('wrong-password', 'Wrong password')
      }

      // await 期间房间可能已被回收/关闭，必须复检。
      if (this.rooms.get(roomId) !== record || record.passwordHash === null) {
        throw new RoomError('room-closed', 'Room is closed')
      }
      if (record.info.locked) {
        throw new RoomError('room-locked', 'Room is locked')
      }
      if (record.members.size + record.pendingMembers.size - 1 >= record.info.maxMembers) {
        throw new RoomError('room-full', 'Room is full')
      }

      // 8. 提交
      const member: MemberRecord = {
        deviceId,
        deviceName,
        role: 'member',
        joinedAt: Date.now(),
        sessionIds: new Set(),
        online: false
      }
      record.members.set(deviceId, member)
      if (request.sessionId) this.attachSession(record, member, request.sessionId)
      record.info.lastActivityAt = Date.now()
      this.refreshCounts(record)
      this.clearFailures(deviceId, roomId, request.remoteAddress)
      const ticket = this.issueTicket(record, deviceId, 'member')
      const projectedMember = this.projectMember(record, member)

      this.emit('member-joined', roomId, projectedMember, this.memberSessionIds(record))
      return { room: this.projectRoom(record), member: projectedMember, ticket }
    } finally {
      record.pendingMembers.delete(deviceId)
    }
  }

  // -------------------------------------------------------------------------
  // membership / lifecycle
  // -------------------------------------------------------------------------

  /** 设备级显式退房：移除成员行与该设备全部会话（含同设备其它标签页） */
  async leaveRoom(roomId: RoomId, deviceId: string): Promise<RoomLeaveResult> {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      throw new RoomError('room-not-found', 'Room not found')
    }
    const member = record.members.get(deviceId)
    if (!member) {
      return { roomId, deviceId, removed: false, closed: false, newOwnerDeviceId: record.realOwnerDeviceId }
    }

    this.detachDeviceSessions(record, member)
    record.members.delete(deviceId)
    this.refreshCounts(record)
    record.info.lastActivityAt = Date.now()

    const isOwner = member.role === 'owner' || record.realOwnerDeviceId === deviceId
    let closed = false
    let newOwnerDeviceId: string | undefined

    if (isOwner && this.config.closeWhenOwnerLeaves) {
      // 先算收件人快照，关房后房间已删，订阅者不得回查。
      const recipients = this.memberSessionIds(record)
      this.closeRoomInternal(record, 'owner-left')
      this.emit('room-closed', roomId, 'owner-left', recipients)
      closed = true
    } else {
      if (isOwner) newOwnerDeviceId = this.transferOwnership(record)
      this.emit('member-left', roomId, deviceId, 'left', this.memberSessionIds(record))
      if (newOwnerDeviceId !== undefined) {
        this.emit('owner-changed', roomId, newOwnerDeviceId, this.memberSessionIds(record))
      }
    }

    const result: RoomLeaveResult = { roomId, deviceId, removed: true, closed }
    if (newOwnerDeviceId !== undefined) result.newOwnerDeviceId = newOwnerDeviceId
    return result
  }

  /** 关房（仅房主） */
  async closeRoom(roomId: RoomId, actorDeviceId: string): Promise<void> {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      throw new RoomError('room-not-found', 'Room not found')
    }
    if (!record.members.has(actorDeviceId)) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
    if (record.realOwnerDeviceId !== actorDeviceId) {
      throw new RoomError('forbidden', 'Only the room owner can close the room')
    }
    const recipients = this.memberSessionIds(record)
    this.closeRoomInternal(record, 'closed-by-owner')
    this.emit('room-closed', roomId, 'closed-by-owner', recipients)
  }

  /**
   * 踢人（仅房主；不能踢自己）。移除成员行 + 摘掉其全部会话 + 清 sessionRooms + 吊票据。
   * 三者缺一：行还在就会被快速通道无密码放回，会话还挂就会被 isSessionMember 放行。
   */
  async kickMember(roomId: RoomId, actorDeviceId: string, targetDeviceId: string): Promise<void> {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      throw new RoomError('room-not-found', 'Room not found')
    }
    if (!record.members.has(actorDeviceId)) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
    if (record.realOwnerDeviceId !== actorDeviceId) {
      throw new RoomError('forbidden', 'Only the room owner can kick members')
    }
    if (targetDeviceId === actorDeviceId) {
      throw new RoomError('forbidden', 'Owner cannot kick itself; use leaveRoom')
    }
    const target = record.members.get(targetDeviceId)
    if (!target) {
      throw new RoomError('not-a-member', 'Target is not a member of this room')
    }

    const targetSessionIds = Array.from(target.sessionIds)
    this.revokeTicketsFor(record, targetDeviceId)
    this.detachDeviceSessions(record, target)
    record.members.delete(targetDeviceId)
    this.refreshCounts(record)
    record.info.lastActivityAt = Date.now()

    this.emit('member-kicked', roomId, targetDeviceId, actorDeviceId, targetSessionIds, this.memberSessionIds(record))
  }

  async changePassword(roomId: RoomId, actorDeviceId: string, password: string): Promise<void> {
    const next = this.assertPassword(password)
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      throw new RoomError('room-not-found', 'Room not found')
    }
    if (!record.members.has(actorDeviceId)) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
    if (record.realOwnerDeviceId !== actorDeviceId) {
      throw new RoomError('forbidden', 'Only the room owner can change the password')
    }

    const hash = await this.hashPassword(next)
    // await 期间房间可能没了。
    if (this.rooms.get(roomId) !== record || record.passwordHash === null) {
      throw new RoomError('room-closed', 'Room is closed')
    }
    record.passwordHash = hash
    record.info.lastActivityAt = Date.now()
    // 房主自己的票据留着：它没被驱逐，只是换了把门锁。
    this.revokeTickets(record, deviceId => deviceId !== actorDeviceId)
    this.emit('password-changed', roomId, this.memberSessionIds(record))
  }

  async setLocked(roomId: RoomId, actorDeviceId: string, locked: boolean): Promise<void> {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      throw new RoomError('room-not-found', 'Room not found')
    }
    if (!record.members.has(actorDeviceId)) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
    if (record.realOwnerDeviceId !== actorDeviceId) {
      throw new RoomError('forbidden', 'Only the room owner can lock the room')
    }
    record.info.locked = Boolean(locked)
    record.info.lastActivityAt = Date.now()
    this.emit('lock-changed', roomId, record.info.locked, this.memberSessionIds(record))
  }

  // -------------------------------------------------------------------------
  // queries
  // -------------------------------------------------------------------------

  /** 可发现房间的公开投影。关闭房间列表时一律为空（fail-closed）。 */
  listRooms(): RoomInfo[] {
    if (!this.config.allowRoomList) return []
    return this.visibleRooms().map(record => this.projectRoom(record))
  }

  getRoomInfo(roomId: RoomId, actorDeviceId: string): RoomInfo {
    const record = this.requireVisibleRoom(roomId)
    void actorDeviceId
    return this.projectRoom(record)
  }

  /**
   * 成员列表。只有该房成员能读；deviceId 一律脱敏（契约 §1.1：成员视图不分视角）。
   * 真实 id 只经 user-joined / member-kicked 等推送语义流转，不从列表反查——
   * 否则房主视角就成了把真 id 集中放在一个可读响应里的泄漏点。
   */
  getMembers(roomId: RoomId, actorDeviceId: string): RoomMember[] {
    const record = this.requireVisibleRoom(roomId)
    if (!record.members.has(actorDeviceId)) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
    return Array.from(record.members.values()).map(member => this.projectMember(record, member))
  }

  /** 含建房占位（见并发与原子性约定） */
  hasRoom(roomId: RoomId): boolean {
    this.pruneReservations(Date.now())
    return this.rooms.has(roomId) || this.createReservations.has(roomId)
  }

  /** 含建房占位（每间在途建房只算一次，见 occupiedRoomCount） */
  getRoomCount(): number {
    this.pruneReservations(Date.now())
    return this.occupiedRoomCount()
  }

  roomCountForDevice(deviceId: string): number {
    return this.ownedRoomCount(deviceId)
  }

  // -------------------------------------------------------------------------
  // auth primitives
  // -------------------------------------------------------------------------

  authenticate(ticket: string, roomId: RoomId): RoomTicket {
    if (typeof ticket !== 'string' || ticket.length === 0) {
      throw new RoomError('invalid-ticket', 'Ticket is required')
    }
    const record = this.tickets.get(ticket)
    if (!record) {
      throw new RoomError('invalid-ticket', 'Ticket is not valid')
    }
    // 票据只能用于它绑定的 roomId。
    if (record.roomId !== roomId) {
      throw new RoomError('invalid-ticket', 'Ticket does not belong to this room')
    }
    if (record.expiresAt <= Date.now()) {
      this.tickets.delete(ticket)
      this.rooms.get(record.roomId)?.tickets.delete(ticket)
      throw new RoomError('invalid-ticket', 'Ticket has expired')
    }
    // 房间没了或它不是成员了，票据也必须失效（关房/踢人/退房链路）。
    const room = this.rooms.get(record.roomId)
    if (!room || room.passwordHash === null || !room.members.has(record.deviceId)) {
      throw new RoomError('invalid-ticket', 'Ticket is no longer valid')
    }
    return record
  }

  /** 解析 Authorization: Bearer <ticket 或 deviceSecret>。两者都不认时 → invalid-ticket。 */
  authenticateBearer(
    authorization: string | undefined,
    roomId?: RoomId
  ): { ticket?: RoomTicket; credential?: DeviceCredential } {
    const value = typeof authorization === 'string' ? authorization : ''
    const match = /^Bearer\s+(.+)$/i.exec(value.trim())
    if (!match) {
      throw new RoomError('invalid-ticket', 'Bearer credential is required')
    }
    const token = match[1].trim()
    if (!token) {
      throw new RoomError('invalid-ticket', 'Credential is not valid')
    }
    // 先当票据认（它是主凭据）；认不出再当 deviceSecret。
    if (this.tickets.has(token)) {
      return { ticket: this.authenticate(token, roomId as RoomId) }
    }
    const credential = this.credentials.get(token)
    if (credential) {
      credential.lastSeenAt = Date.now()
      return { credential }
    }
    throw new RoomError('invalid-ticket', 'Credential is not valid')
  }

  isMember(roomId: RoomId, deviceId: string): boolean {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) return false
    return record.members.has(deviceId)
  }

  isOwner(roomId: RoomId, deviceId: string): boolean {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) return false
    return record.members.has(deviceId) && record.realOwnerDeviceId === deviceId
  }

  isSessionMember(roomId: RoomId, deviceId: string, sessionId: string): boolean {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) return false
    // 只有「这个具体会话」挂在该成员行上才算，否则残留标签页能一直留在房里。
    const member = record.members.get(deviceId)
    if (!member) return false
    return member.sessionIds.has(sessionId)
  }

  getMemberSessionIds(roomId: RoomId): string[] {
    const record = this.rooms.get(roomId)
    if (!record) return []
    return this.memberSessionIds(record)
  }

  // -------------------------------------------------------------------------
  // liveness / session cleanup
  // -------------------------------------------------------------------------

  touch(roomId: RoomId): void {
    const record = this.rooms.get(roomId)
    if (!record) return
    record.info.lastActivityAt = Date.now()
  }

  /**
   * 会话断开：摘掉会话，保留席位（online=false）。返回受影响的房间。
   * 不吊销票据：契约 §1.10 的吊销清单只有显式退房/被踢/关房/改密/回收，断线不在其中；
   * 票据按 (roomId, deviceId) 记账不分 会话，这里若顺手吊销，同设备仍在线会话的
   * 房间凭据会被一次标签页关闭连带作废（test/rooms-limits.test.ts 多会话票据用例）。
   */
  dropSession(sessionId: string, deviceId: string): RoomId[] {
    const affected: RoomId[] = []
    for (const [roomId, record] of this.rooms) {
      const member = record.members.get(deviceId)
      if (!member || !member.sessionIds.has(sessionId)) continue
      member.sessionIds.delete(sessionId)
      member.online = member.sessionIds.size > 0
      const sessions = this.sessionRooms.get(sessionId)
      if (sessions) {
        sessions.delete(roomId)
        if (sessions.size === 0) this.sessionRooms.delete(sessionId)
      }
      if (member.role === 'owner' && member.sessionIds.size === 0) {
        record.ownerOfflineSince = Date.now()
      }
      affected.push(roomId)
    }
    return affected
  }

  /** 一次主动清扫：过期票据 / 墓碑 / 占位 / 凭据 + 空闲回收。测试可手动调。 */
  sweep(now: number = Date.now()): void {
    this.runMaintenance(now)
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** 仅供测试提速：调低 scrypt 成本。生产路径不碰它。 */
  setScryptParams(params: Partial<ScryptParams>): void {
    this.scryptParams = { ...this.scryptParams, ...params }
  }

  private assertRoomId(roomId: unknown): RoomId {
    if (typeof roomId !== 'string' || !/^[0-9]+$/.test(roomId)) {
      throw new RoomError('invalid-room-id', 'Room id must be digits only')
    }
    if (roomId.length < ROOM_ID_MIN_LENGTH || roomId.length > ROOM_ID_MAX_LENGTH) {
      throw new RoomError('invalid-room-id', `Room id must be ${ROOM_ID_MIN_LENGTH}-${ROOM_ID_MAX_LENGTH} digits`)
    }
    return roomId
  }

  private assertCustomRoomId(roomId: unknown): RoomId {
    return this.assertRoomId(roomId)
  }

  private assertPassword(password: unknown): string {
    if (typeof password !== 'string') {
      throw new RoomError('invalid-password', 'Password is required')
    }
    if (password.length < this.config.minPasswordLength) {
      throw new RoomError('invalid-password', `Password must be at least ${this.config.minPasswordLength} characters`)
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new RoomError('invalid-password', `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)
    }
    return password
  }

  private normalizeMaxMembers(value: unknown): number {
    if (value === undefined) return this.config.maxMembersPerRoom
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new RoomError('invalid-argument', 'maxMembers must be a positive integer')
    }
    return Math.min(value, this.config.maxMembersPerRoom)
  }

  private normalizeRoomName(name: unknown): string {
    const value = typeof name === 'string' ? name.trim() : ''
    return value.length > 0 ? value.slice(0, 64) : 'Room'
  }

  private pickRandomRoomId(): RoomId {
    const length = Math.max(ROOM_ID_MIN_LENGTH, Math.min(ROOM_ID_MAX_LENGTH, this.config.roomCodeLength))
    for (let attempt = 0; attempt < ROOM_CODE_MAX_ATTEMPTS; attempt++) {
      const candidate = generateRoomCode(length)
      if (!this.rooms.has(candidate) && !this.createReservations.has(candidate)) {
        // 墓碑只说明房号曾经被用过；允许复用（否则房号池会被耗干），
        // 但必须是「清除后可用」，所以这里把旧墓碑删掉。
        this.closedRooms.delete(candidate)
        return candidate
      }
    }
    throw new RoomError('room-code-exhausted', 'Could not allocate a free room code')
  }

  // --- password hashing ---

  private async hashPassword(password: string): Promise<string> {
    const { N, r, p } = this.scryptParams
    const salt = randomBytes(SCRYPT_SALT_BYTES)
    // 哨兵字节见 PASSWORD_SENTINEL：哈希必须精确到整个字符串，尾随 NUL 不得被剥掉。
    const derived = await scrypt(password + PASSWORD_SENTINEL, salt, SCRYPT_KEYLEN, { N, r, p, maxmem: SCRYPT_MAXMEM })
    return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${derived.toString('hex')}`
  }

  private async verifyPassword(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') {
      throw new RoomError('internal-error', 'Stored password hash is malformed')
    }
    const N = Number.parseInt(parts[1], 10)
    const r = Number.parseInt(parts[2], 10)
    const p = Number.parseInt(parts[3], 10)
    const salt = Buffer.from(parts[4], 'hex')
    const expected = Buffer.from(parts[5], 'hex')
    if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || expected.length === 0) {
      throw new RoomError('internal-error', 'Stored password hash is malformed')
    }
    // 与 hashPassword 同一域：哨兵字节保证尾随 NUL 参与哈希，比对精确到整个字符串。
    const derived = await scrypt(password + PASSWORD_SENTINEL, salt, expected.length, { N, r, p, maxmem: SCRYPT_MAXMEM })
    // 长度不等时也要走等长比较，不能先短路成 ===（否则泄露长度信息）。
    const a = derived.length === expected.length ? derived : Buffer.alloc(expected.length)
    const b = expected
    if (derived.length !== expected.length) {
      timingSafeEqual(a, b)
      return false
    }
    return timingSafeEqual(a, b)
  }

  // --- tickets ---

  private issueTicket(record: RoomRecord, deviceId: string, role: RoomRole): RoomTicket {
    // 重签即吊销同 (roomId, deviceId) 的旧票，避免票据无限堆积。
    this.revokeTickets(record, owner => owner === deviceId)
    const now = Date.now()
    const ticket: RoomTicket = {
      ticket: randomBytes(32).toString('hex'),
      roomId: record.info.roomId,
      deviceId,
      role,
      issuedAt: now,
      expiresAt: now + this.config.ticketTtlMs
    }
    record.tickets.add(ticket.ticket)
    this.tickets.set(ticket.ticket, ticket)
    return ticket
  }

  private revokeTickets(record: RoomRecord, predicate: (deviceId: string) => boolean): void {
    for (const ticketId of Array.from(record.tickets)) {
      const ticket = this.tickets.get(ticketId)
      if (!ticket) {
        record.tickets.delete(ticketId)
        continue
      }
      if (predicate(ticket.deviceId)) {
        record.tickets.delete(ticketId)
        this.tickets.delete(ticketId)
      }
    }
  }

  private revokeTicketsFor(record: RoomRecord, deviceId: string): void {
    this.revokeTickets(record, owner => owner === deviceId)
  }

  private ticketsForDevice(record: RoomRecord, deviceId: string): RoomTicket[] {
    const out: RoomTicket[] = []
    for (const ticketId of record.tickets) {
      const ticket = this.tickets.get(ticketId)
      if (ticket && ticket.deviceId === deviceId) out.push(ticket)
    }
    return out
  }

  // --- members ---

  private attachSession(record: RoomRecord, member: MemberRecord, sessionId: string): void {
    member.sessionIds.add(sessionId)
    member.online = true
    let sessions = this.sessionRooms.get(sessionId)
    if (!sessions) {
      sessions = new Set()
      this.sessionRooms.set(sessionId, sessions)
    }
    sessions.add(record.info.roomId)
    if (member.role === 'owner') record.ownerOfflineSince = null
  }

  /** 摘掉某设备的全部会话（含 sessionRooms 索引），但保留成员行。 */
  private detachDeviceSessions(record: RoomRecord, member: MemberRecord): void {
    for (const sessionId of Array.from(member.sessionIds)) {
      const sessions = this.sessionRooms.get(sessionId)
      if (sessions) {
        sessions.delete(record.info.roomId)
        if (sessions.size === 0) this.sessionRooms.delete(sessionId)
      }
    }
    member.sessionIds.clear()
    member.online = false
  }

  private refreshCounts(record: RoomRecord): void {
    record.info.memberCount = record.members.size
    const owner = record.members.get(record.realOwnerDeviceId)
    record.info.ownerOnline = owner ? owner.online : false
  }

  private memberSessionIds(record: RoomRecord): string[] {
    const out: string[] = []
    for (const member of record.members.values()) {
      for (const sessionId of member.sessionIds) out.push(sessionId)
    }
    return out
  }

  private transferOwnership(record: RoomRecord): string | undefined {
    // 房主走了且不关房：把房主身份交给最早加入的在线成员；没有在线成员就保留原房主身份。
    let next: MemberRecord | undefined
    for (const member of record.members.values()) {
      if (!member.online) continue
      if (!next || member.joinedAt < next.joinedAt) next = member
    }
    if (!next) return undefined
    next.role = 'owner'
    record.realOwnerDeviceId = next.deviceId
    record.info.ownerDeviceId = maskDeviceId(next.deviceId)
    record.ownerOfflineSince = null
    this.revokeTickets(record, () => true)
    for (const member of record.members.values()) this.issueTicket(record, member.deviceId, member.role)
    this.refreshCounts(record)
    return next.deviceId
  }

  private closeRoomInternal(record: RoomRecord, reason: RoomCloseReason): void {
    const roomId = record.info.roomId
    for (const member of record.members.values()) {
      for (const sessionId of member.sessionIds) {
        const sessions = this.sessionRooms.get(sessionId)
        if (sessions) {
          sessions.delete(roomId)
          if (sessions.size === 0) this.sessionRooms.delete(sessionId)
        }
      }
      member.sessionIds.clear()
      member.online = false
    }
    record.members.clear()
    this.revokeTickets(record, () => true)
    this.rooms.delete(roomId)
    this.createReservations.delete(roomId)
    this.closedRooms.set(roomId, { closedAt: Date.now(), reason })
    this.pruneClosedRooms()
  }

  private ownedRoomCount(deviceId: string): number {
    let count = 0
    for (const record of this.rooms.values()) {
      if (record.passwordHash === null) continue
      if (record.realOwnerDeviceId === deviceId) count++
    }
    return count
  }

  /**
   * 全局房间占用数 = 已建成的房间 + 在途占位。占位 record 会同时写进 rooms
   * （passwordHash=null）与 createReservations 两张表，直接把两个 size 相加会把
   * 同一间在途建房算两次，并发建房在还有一半名额时就会被误拒
   * （test/rooms-limits.test.ts「并发建房在还有名额时不得被误拒」）。
   */
  private occupiedRoomCount(): number {
    let count = 0
    for (const record of this.rooms.values()) {
      if (record.passwordHash !== null) count++
    }
    return count + this.createReservations.size
  }

  private pruneReservations(now: number): void {
    for (const [roomId, expiresAt] of this.createReservations) {
      if (expiresAt > now) continue
      this.createReservations.delete(roomId)
      const record = this.rooms.get(roomId)
      // 只清还是占位的那种；已填哈希的房间说明建房成功了。
      if (record && record.passwordHash === null) this.rooms.delete(roomId)
    }
  }

  private pruneClosedRooms(): void {
    const limit = Math.max(1, this.config.maxRooms)
    while (this.closedRooms.size > limit) {
      const oldest = this.closedRooms.keys().next().value
      if (oldest === undefined) break
      this.closedRooms.delete(oldest)
    }
  }

  // --- visibility projection ---

  private visibleRooms(): RoomRecord[] {
    const out: RoomRecord[] = []
    for (const record of this.rooms.values()) {
      // 占位不是房间；不可发现的房间只在成员自己看得到（由 getRoomInfo 兜）。
      if (record.passwordHash === null) continue
      if (!record.info.discoverable) continue
      out.push(record)
    }
    return out
  }

  private requireVisibleRoom(roomId: RoomId): RoomRecord {
    const record = this.rooms.get(roomId)
    if (!record || record.passwordHash === null) {
      this.assertRoomId(roomId)
      throw new RoomError('room-not-found', 'Room not found')
    }
    return record
  }

  private projectRoom(record: RoomRecord): RoomInfo {
    return {
      roomId: record.info.roomId,
      name: record.info.name,
      // 脱敏：对外任何投影都不给真 deviceId。
      ownerDeviceId: maskDeviceId(record.realOwnerDeviceId),
      ownerOnline: record.ownerOfflineSince === null && (record.members.get(record.realOwnerDeviceId)?.online ?? false),
      createdAt: record.info.createdAt,
      lastActivityAt: record.info.lastActivityAt,
      memberCount: record.members.size,
      maxMembers: record.info.maxMembers,
      locked: record.info.locked,
      discoverable: record.info.discoverable
    }
  }

  private projectMember(record: RoomRecord, member: MemberRecord): RoomMember {
    return {
      // 对外任何成员视图都只给脱敏值；真值只在本记录与事件推送语义里存在。
      deviceId: maskDeviceId(member.deviceId),
      deviceName: member.deviceName,
      role: member.role,
      joinedAt: member.joinedAt,
      sessionCount: member.sessionIds.size,
      online: member.online
    }
  }

  // --- rate limiting ---

  private assertNotLocked(deviceId: string, roomId: RoomId, remoteAddress: string | undefined, now: number): void {
    let maxRetry = 0
    for (const key of this.rateLimitKeys(deviceId, roomId, remoteAddress)) {
      const lockout = this.lockouts.get(key)
      if (!lockout) continue
      const remaining = lockout.until - now
      if (remaining > 0) maxRetry = Math.max(maxRetry, remaining)
    }
    if (maxRetry > 0) {
      throw new RoomError('too-many-attempts', 'Too many join attempts', { retryAfterMs: maxRetry })
    }
  }

  private recordFailure(deviceId: string, roomId: RoomId, remoteAddress: string | undefined, now: number): void {
    const windowMs = this.config.joinAttemptWindowMs
    for (const key of this.rateLimitKeys(deviceId, roomId, remoteAddress)) {
      const hits = (this.failureWindows.get(key) ?? []).filter(at => now - at < windowMs)
      hits.push(now)
      this.failureWindows.set(key, hits)
      if (hits.length >= this.config.maxJoinAttempts) {
        this.lockouts.set(key, { until: now + this.config.joinLockoutMs, reason: 'attempts' })
      }
    }
  }

  /**
   * 清失败计数与锁定。'all' 用于「刚验证过密码/刚建成房间」的场景，设备键与
   * 共享 ip 键一起清（test/rooms.test.ts「成功进房也会清掉该 IP 的失败计数」）；
   * 'device-only' 用于成员快速通道——它没验证任何凭据之外的东西，共享的
   * ip:<roomId>:<addr> 桶属于同 IP 的所有设备，不能被一次免密回房清掉。
   */
  private clearFailures(
    deviceId: string,
    roomId: RoomId,
    remoteAddress: string | undefined,
    scope: 'all' | 'device-only' = 'all'
  ): void {
    const keys = scope === 'device-only' ? [`device:${deviceId}`] : this.rateLimitKeys(deviceId, roomId, remoteAddress)
    for (const key of keys) {
      this.failureWindows.delete(key)
      this.lockouts.delete(key)
    }
  }

  private rateLimitKeys(deviceId: string, roomId: RoomId, remoteAddress: string | undefined): string[] {
    const keys = [`device:${deviceId}`]
    // 按房间+IP 的维度只在拿到地址时有意义；没有地址就不能凭空造一个共享桶。
    if (typeof remoteAddress === 'string' && remoteAddress.length > 0) {
      keys.push(`ip:${roomId}:${remoteAddress}`)
    }
    return keys
  }

  // --- maintenance ---

  private runMaintenance(now: number = Date.now()): void {
    this.pruneReservations(now)
    this.pruneClosedRooms()
    for (const [ticketId, ticket] of Array.from(this.tickets)) {
      if (ticket.expiresAt <= now) {
        this.tickets.delete(ticketId)
        this.rooms.get(ticket.roomId)?.tickets.delete(ticketId)
      }
    }
    for (const [key, hits] of Array.from(this.failureWindows)) {
      const kept = hits.filter(at => now - at < this.config.joinAttemptWindowMs)
      if (kept.length === 0) this.failureWindows.delete(key)
      else this.failureWindows.set(key, kept)
    }
    for (const [key, lockout] of Array.from(this.lockouts)) {
      if (lockout.until <= now) this.lockouts.delete(key)
    }
    this.evictCredentials()
    this.reapIdleRooms(now)
  }

  private reapIdleRooms(now: number): void {
    for (const [roomId, record] of Array.from(this.rooms)) {
      if (record.passwordHash === null) continue
      const online = Array.from(record.members.values()).some(member => member.online)
      const idle = now - record.info.lastActivityAt > this.config.idleTtlMs
      const ownerGone = record.ownerOfflineSince !== null && now - record.ownerOfflineSince > this.config.idleTtlMs
      if ((!online && idle) || ownerGone) {
        const recipients = this.memberSessionIds(record)
        this.closeRoomInternal(record, 'idle-timeout')
        this.emit('room-closed', roomId, 'idle-timeout', recipients)
      }
    }
  }
}
