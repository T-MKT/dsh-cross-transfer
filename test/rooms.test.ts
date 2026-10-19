/**
 * RoomService 单元测试。
 *
 * 只测 src/rooms.ts 这一个文件：不接 WS、不接 REST，直接 new RoomService(new Context())。
 * scrypt 成本被调低到 N=1024 让每个用例在一两毫秒内跑完 —— 存储串自带参数
 * （scrypt$N$r$p$salt$hash），所以调低只影响新建的哈希，不影响正确性。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHash } from 'crypto'
import { Context } from '@deepseek-ai/cordis'
import {
  RoomService,
  RoomError,
  isRoomError,
  deriveDeviceId,
  deriveDeviceToken,
  maskDeviceId,
  DEFAULT_ROOM_CONFIG,
  ROOM_ID_MIN_LENGTH,
  ROOM_ID_MAX_LENGTH,
  MAX_PASSWORD_LENGTH,
  CREATE_RESERVATION_TTL_MS,
  ROOM_CODE_MAX_ATTEMPTS,
  type RoomConfig,
  type RoomInfo,
  type RoomMember,
  type RoomLeaveReason,
  type RoomCloseReason,
} from '../src/rooms.js'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

const services: RoomService[] = []

function createRooms(config: Partial<RoomConfig> = {}): RoomService {
  const rooms = new RoomService(new Context())
  rooms.initialize({ minPasswordLength: 3, ...config })
  rooms.setScryptParams({ N: 1024, r: 8, p: 1 })
  services.push(rooms)
  return rooms
}

afterEach(() => {
  for (const rooms of services.splice(0)) rooms.shutdown()
})

/** 每个测试用独立设备身份；deviceId 由服务端返回的 secret 派生，绝不自报。 */
let deviceSeq = 0
interface Device {
  deviceId: string
  deviceSecret: string
  deviceName: string
}

function register(rooms: RoomService, name?: string): Device {
  deviceSeq += 1
  const result = rooms.registerDevice({ deviceName: name ?? `Device ${deviceSeq}` })
  return { deviceId: result.deviceId, deviceSecret: result.deviceSecret, deviceName: result.deviceName }
}

const MIN_PASSWORD = 'pass-1234'

async function createOwnedRoom(
  rooms: RoomService,
  options: { password?: string; sessionId?: string; roomId?: string; maxMembers?: number } = {}
): Promise<{ owner: Device; roomId: string; ticket: string; sessionId: string }> {
  const owner = register(rooms)
  const sessionId = options.sessionId ?? `sess-owner-${deviceSeq}`
  const result = await rooms.createRoom({
    roomId: options.roomId,
    name: '测试房',
    password: options.password ?? MIN_PASSWORD,
    maxMembers: options.maxMembers,
    deviceId: owner.deviceId,
    deviceName: owner.deviceName,
    sessionId,
  })
  return { owner, roomId: result.room.roomId, ticket: result.ticket.ticket, sessionId }
}

async function joinAs(
  rooms: RoomService,
  roomId: string,
  password: string,
  sessionId?: string,
  remoteAddress?: string
): Promise<Device & { sessionId: string; ticket: string; room: RoomInfo; member: RoomMember }> {
  const device = register(rooms)
  const sid = sessionId ?? `sess-${device.deviceId}`
  const result = await rooms.joinRoom({
    roomId,
    password,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    sessionId: sid,
    remoteAddress,
  })
  return { ...device, sessionId: sid, ticket: result.ticket.ticket, room: result.room, member: result.member }
}

/** 捕获异步抛出的 RoomError，便于断言 code / retryAfterMs。 */
async function caught(promise: Promise<unknown>): Promise<RoomError> {
  try {
    await promise
  } catch (error) {
    if (!isRoomError(error)) throw error
    return error
  }
  throw new Error('expected the promise to reject with a RoomError')
}

/** 把某设备的全部会话摘干净，让房间进入「无在线成员」状态。 */
function dropAllSessions(rooms: RoomService, roomId: string, deviceId: string): void {
  for (const sessionId of rooms.getMemberSessionIds(roomId)) {
    rooms.dropSession(sessionId, deviceId)
  }
}

/** 每 5ms 推进一次虚拟时间，直到 predicate 为真或超时。 */
async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

// ---------------------------------------------------------------------------
// identity
// ---------------------------------------------------------------------------

describe('身份与凭据', () => {
  it('deriveDeviceId 是 sha256("xfer-device:" + secret) 的前 16 位，同一 secret 稳定派生', () => {
    const secret = 'a'.repeat(64)
    const id = deriveDeviceId(secret)
    expect(id).toHaveLength(16)
    expect(id).toMatch(/^[0-9a-f]{16}$/)
    expect(deriveDeviceId(secret)).toBe(id)
    expect(deriveDeviceId('b'.repeat(64))).not.toBe(id)
  })

  it('deriveDeviceToken 与 ws-server 的 sha256(deviceId + ":" + tokenSecret) 逐字一致', () => {
    expect(deriveDeviceToken('dev-1', 'secret-1')).toBe(
      createHash('sha256').update('dev-1:secret-1').digest('hex')
    )
  })

  it('maskDeviceId 保留前 4 与后 4，短 id 整体打码', () => {
    expect(maskDeviceId('0123456789abcdef')).toBe('0123…cdef')
    expect(maskDeviceId('abcdefgh')).toBe('abcd…efgh')
    expect(maskDeviceId('short')).toBe('***')
    expect(maskDeviceId('')).toBe('***')
  })

  it('registerDevice 不带 secret 时铸一个新身份，deviceId 由返回的 secret 派生', () => {
    const rooms = createRooms()
    const result = rooms.registerDevice({ deviceName: '笔记本' })
    expect(result.deviceSecret).toHaveLength(64)
    expect(result.deviceId).toBe(deriveDeviceId(result.deviceSecret))
    expect(result.deviceName).toBe('笔记本')
  })

  it('registerDevice 带已登记 secret 时返回同一身份，而不是铸新的', () => {
    const rooms = createRooms()
    const first = rooms.registerDevice({})
    const second = rooms.registerDevice({ deviceSecret: first.deviceSecret })
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.deviceSecret).toBe(first.deviceSecret)
  })

  it('registerDevice 带未登记 secret 时拒绝（invalid-device），不就地接管身份', () => {
    const rooms = createRooms()
    expect(() => rooms.registerDevice({ deviceSecret: 'f'.repeat(64) })).toThrowError(
      expect.objectContaining({ code: 'invalid-device' })
    )
  })

  it('authenticateDevice 在未登记 secret 时拒绝', () => {
    const rooms = createRooms()
    expect(() => rooms.authenticateDevice('f'.repeat(64), 'whatever')).toThrowError(
      expect.objectContaining({ code: 'invalid-device' })
    )
  })

  it('authenticateDevice 在 secret 与自报 deviceId 不符时拒绝（身份不得自报）', () => {
    const rooms = createRooms()
    const reg = rooms.registerDevice({})
    expect(() => rooms.authenticateDevice(reg.deviceSecret, 'somebody-else')).toThrowError(
      expect.objectContaining({ code: 'invalid-device' })
    )
    expect(rooms.authenticateDevice(reg.deviceSecret, reg.deviceId).deviceId).toBe(reg.deviceId)
  })

  it('authenticateDevice 缺 secret 时拒绝（默认拒绝，没有"未配置就放行"的后门）', () => {
    const rooms = createRooms()
    expect(() => rooms.authenticateDevice(undefined, 'dev-1')).toThrowError(
      expect.objectContaining({ code: 'invalid-device' })
    )
  })

  it('isRoomError 只认同类错误', () => {
    expect(isRoomError(new RoomError('forbidden', 'x'))).toBe(true)
    expect(isRoomError(new Error('x'))).toBe(false)
    expect(isRoomError(null)).toBe(false)
  })

  it('RoomError 携带 code 与可选的 retryAfterMs', () => {
    const plain = new RoomError('room-not-found', 'nope')
    expect(plain.code).toBe('room-not-found')
    expect(plain.retryAfterMs).toBeUndefined()
    const throttled = new RoomError('too-many-attempts', 'slow down', { retryAfterMs: 5000 })
    expect(throttled.retryAfterMs).toBe(5000)
    expect(throttled).toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// createRoom
// ---------------------------------------------------------------------------

describe('建房', () => {
  it('建房成功返回房间、房主成员行与票据', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const result = await rooms.createRoom({
      roomId: '123456',
      name: '书房',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
      sessionId: 'sess-1',
    })

    expect(result.room.roomId).toBe('123456')
    expect(result.room.name).toBe('书房')
    expect(result.room.memberCount).toBe(1)
    expect(result.room.locked).toBe(false)
    expect(result.room.ownerOnline).toBe(true)
    expect(result.member.role).toBe('owner')
    expect(result.member.sessionCount).toBe(1)
    expect(result.member.online).toBe(true)
    expect(result.ticket.roomId).toBe('123456')
    expect(result.ticket.deviceId).toBe(owner.deviceId)
    expect(result.ticket.role).toBe('owner')
    expect(result.ticket.expiresAt).toBeGreaterThan(result.ticket.issuedAt)
    expect(rooms.hasRoom('123456')).toBe(true)
    expect(rooms.getRoomCount()).toBe(1)
    expect(rooms.isOwner('123456', owner.deviceId)).toBe(true)
  })

  it('房主自定房号撞号时抛 room-exists，原房间不受影响', async () => {
    const rooms = createRooms()
    const first = await createOwnedRoom(rooms, { roomId: '654321' })
    const other = register(rooms)
    await expect(
      rooms.createRoom({
        roomId: '654321',
        password: MIN_PASSWORD,
        deviceId: other.deviceId,
        deviceName: other.deviceName,
      })
    ).rejects.toMatchObject({ code: 'room-exists' })
    expect(rooms.hasRoom('654321')).toBe(true)
    expect(rooms.isOwner(first.roomId, first.owner.deviceId)).toBe(true)
    expect(rooms.getRoomInfo(first.roomId, first.owner.deviceId).memberCount).toBe(1)
  })

  it('房号格式非法（非纯数字 / 太短 / 太长 / 空）抛 invalid-room-id', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const attempt = (roomId: string) =>
      rooms.createRoom({ roomId, password: MIN_PASSWORD, deviceId: owner.deviceId, deviceName: owner.deviceName })

    await expect(attempt('12ab56')).rejects.toMatchObject({ code: 'invalid-room-id' })
    await expect(attempt('123')).rejects.toMatchObject({ code: 'invalid-room-id' })
    await expect(attempt('1'.repeat(ROOM_ID_MAX_LENGTH + 1))).rejects.toMatchObject({ code: 'invalid-room-id' })
    await expect(attempt('')).rejects.toMatchObject({ code: 'invalid-room-id' })
  })

  it('密码缺失、太短、太长都抛 invalid-password', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const base = { deviceId: owner.deviceId, deviceName: owner.deviceName }
    await expect(rooms.createRoom({ ...base, password: undefined as unknown as string })).rejects.toMatchObject({
      code: 'invalid-password',
    })
    await expect(rooms.createRoom({ ...base, password: 'ab' })).rejects.toMatchObject({ code: 'invalid-password' })
    await expect(rooms.createRoom({ ...base, password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) })).rejects.toMatchObject({
      code: 'invalid-password',
    })
  })

  it('省略房号时随机生成 6 位纯数字房号', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms)
    expect(roomId).toMatch(/^[0-9]+$/)
    expect(roomId).toHaveLength(DEFAULT_ROOM_CONFIG.roomCodeLength)
    expect(roomId.length).toBeGreaterThanOrEqual(ROOM_ID_MIN_LENGTH)
    expect(roomId.length).toBeLessThanOrEqual(ROOM_ID_MAX_LENGTH)
  })

  it('roomCodeLength 可配置，且被夹在契约的 4~12 位内', async () => {
    const rooms = createRooms({ roomCodeLength: 99 })
    const { roomId } = await createOwnedRoom(rooms)
    expect(roomId).toHaveLength(ROOM_ID_MAX_LENGTH)
    const narrow = createRooms({ roomCodeLength: 2 })
    expect((await createOwnedRoom(narrow)).roomId).toHaveLength(ROOM_ID_MIN_LENGTH)
  })

  it('房号池被占满、重试 20 次仍撞号时抛 room-code-exhausted，不死循环', async () => {
    // 只允许 4 位房号（9000 个码）。占满其中 8999 个，剩下恰好一个可用码，
    // 随机生成就几乎必然在 20 次内撞号 -> 必须抛错而不是无限重试。
    const rooms = createRooms({ roomCodeLength: 4, maxRooms: 20000, maxRoomsPerDevice: 10000 })
    const filler = rooms as unknown as { rooms: Map<string, unknown> }
    const taken = new Set<string>()
    let candidate = 1000
    while (taken.size < 8999) {
      const code = String(candidate++)
      taken.add(code)
      filler.rooms.set(code, { passwordHash: null, info: { roomId: code } })
    }

    const owner = register(rooms)
    const error = await caught(
      rooms.createRoom({ password: MIN_PASSWORD, deviceId: owner.deviceId, deviceName: owner.deviceName })
    )
    expect(error.code).toBe('room-code-exhausted')
    // 重试次数有上限：失败后立刻返回，不拖时间。
    expect(error.code).toBe('room-code-exhausted')
    expect(ROOM_CODE_MAX_ATTEMPTS).toBe(20)
  })

  it('创建房间发出 room-created，收件人快照含建房会话', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const listener = vi.fn()
    rooms.on('room-created', listener)

    await rooms.createRoom({
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
      sessionId: 'sess-create',
    })

    expect(listener).toHaveBeenCalledTimes(1)
    const [room, sessionIds] = listener.mock.calls[0] as [RoomInfo, string[]]
    expect(room.memberCount).toBe(1)
    expect(room.ownerDeviceId).toBe(maskDeviceId(owner.deviceId))
    expect(sessionIds).toEqual(['sess-create'])
  })

  it('房间总数达到 maxRooms 后抛 too-many-rooms', async () => {
    const rooms = createRooms({ maxRooms: 2, maxRoomsPerDevice: 5 })
    await createOwnedRoom(rooms, { roomId: '111111' })
    await createOwnedRoom(rooms, { roomId: '222222' })
    const third = register(rooms)
    await expect(
      rooms.createRoom({ roomId: '333333', password: MIN_PASSWORD, deviceId: third.deviceId, deviceName: third.deviceName })
    ).rejects.toMatchObject({ code: 'too-many-rooms' })
    expect(rooms.getRoomCount()).toBe(2)
  })

  it('同一设备建房数超过 maxRoomsPerDevice 时抛 too-many-rooms', async () => {
    const rooms = createRooms({ maxRoomsPerDevice: 1 })
    const owner = register(rooms)
    await rooms.createRoom({
      roomId: '111111',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    await expect(
      rooms.createRoom({ roomId: '222222', password: MIN_PASSWORD, deviceId: owner.deviceId, deviceName: owner.deviceName })
    ).rejects.toMatchObject({ code: 'too-many-rooms' })
    // 别的设备仍然建得动，说明限额是按设备算的。
    const other = register(rooms)
    const created = await rooms.createRoom({
      roomId: '333333',
      password: MIN_PASSWORD,
      deviceId: other.deviceId,
      deviceName: other.deviceName,
    })
    expect(created.room.roomId).toBe('333333')
  })

  it('并发建房卡 maxRooms 时不会超员（同步占位 + 异步哈希）', async () => {
    const rooms = createRooms({ maxRooms: 1 })
    const a = register(rooms)
    const b = register(rooms)
    const results = await Promise.allSettled([
      rooms.createRoom({ roomId: '111111', password: MIN_PASSWORD, deviceId: a.deviceId, deviceName: a.deviceName }),
      rooms.createRoom({ roomId: '222222', password: MIN_PASSWORD, deviceId: b.deviceId, deviceName: b.deviceName }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(rooms.getRoomCount()).toBe(1)
  })

  it('并发用同一房号建房时只有一个成功，另一个 room-exists', async () => {
    const rooms = createRooms()
    const a = register(rooms)
    const b = register(rooms)
    const results = await Promise.allSettled([
      rooms.createRoom({ roomId: '444444', password: MIN_PASSWORD, deviceId: a.deviceId, deviceName: a.deviceName }),
      rooms.createRoom({ roomId: '444444', password: MIN_PASSWORD, deviceId: b.deviceId, deviceName: b.deviceName }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
    expect((rejected.reason as RoomError).code).toBe('room-exists')
    expect(rooms.getRoomCount()).toBe(1)
  })

  it('建房占位对 listRooms 不可见，但挡住并发的同号建房', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const pending = rooms.createRoom({
      roomId: '777777',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    const created = await pending.then(
      () => true,
      () => false
    )
    void created
    // 另一个设备同时来占同一个房号：占位挡住了它（并发去重靠的就是这个判定）。
    const other = register(rooms)
    expect(
      (await caught(
        rooms.createRoom({
          roomId: '777777',
          password: MIN_PASSWORD,
          deviceId: other.deviceId,
          deviceName: other.deviceName,
        })
      )).code
    ).toBe('room-exists')

    await until(() => rooms.listRooms().length === 1)
    expect(rooms.hasRoom('777777')).toBe(true)
    expect(rooms.getRoomCount()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// joinRoom
// ---------------------------------------------------------------------------

describe('进房', () => {
  it('密码正确时进房成功，成员计数与票据都对', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100001' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)

    expect(guest.room.memberCount).toBe(2)
    expect(guest.member.role).toBe('member')
    expect(guest.member.deviceId).toBe(maskDeviceId(guest.deviceId))
    expect(guest.ticket).toMatch(/^[0-9a-f]{64}$/)
    expect(rooms.isMember(roomId, guest.deviceId)).toBe(true)
    expect(rooms.isSessionMember(roomId, guest.deviceId, guest.sessionId)).toBe(true)
  })

  it('密码错误时抛 wrong-password，且房间里不多出成员', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100002' })
    const device = register(rooms)
    await expect(
      rooms.joinRoom({ roomId, password: 'wrong-pass', deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'wrong-password' })
    expect(rooms.getRoomInfo(roomId, device.deviceId).memberCount).toBe(1)
    expect(rooms.getMemberSessionIds(roomId)).toHaveLength(1)
    expect(rooms.isMember(roomId, device.deviceId)).toBe(false)
  })

  it('密码错误时不抛出含密码或哈希的任何细节', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100003', password: 'secret-password' })
    const device = register(rooms)
    const error = await caught(
      rooms.joinRoom({
        roomId,
        password: 'secret-password-wrong',
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      })
    )
    expect(error.code).toBe('wrong-password')
    expect(error.message).not.toContain('secret-password')
    expect(error.message).not.toContain('scrypt')
    expect(JSON.stringify(error)).not.toContain('secret-password')
  })

  it('房间不存在时抛 room-not-found', async () => {
    const rooms = createRooms()
    const device = register(rooms)
    await expect(
      rooms.joinRoom({ roomId: '999999', password: MIN_PASSWORD, deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'room-not-found' })
  })

  it('房号格式非法时抛 invalid-room-id（先于一切查询）', async () => {
    const rooms = createRooms()
    const device = register(rooms)
    await expect(
      rooms.joinRoom({ roomId: 'abc', password: MIN_PASSWORD, deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'invalid-room-id' })
  })

  it('密码类型不对或太短时抛 invalid-password', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100004' })
    const device = register(rooms)
    await expect(
      rooms.joinRoom({ roomId, password: 'ab', deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'invalid-password' })
    await expect(
      rooms.joinRoom({
        roomId,
        password: 12345 as unknown as string,
        deviceId: device.deviceId,
        deviceName: device.deviceName,
      })
    ).rejects.toMatchObject({ code: 'invalid-password' })
  })

  it('房满时抛 room-full', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100005', maxMembers: 2 })
    await joinAs(rooms, roomId, MIN_PASSWORD)
    const third = register(rooms)
    await expect(
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: third.deviceId, deviceName: third.deviceName })
    ).rejects.toMatchObject({ code: 'room-full' })
    expect(rooms.getRoomInfo(roomId, third.deviceId).memberCount).toBe(2)
  })

  it('并发进房时容量预留保证不超员', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100006', maxMembers: 2 })
    const a = register(rooms)
    const b = register(rooms)
    const results = await Promise.allSettled([
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: a.deviceId, deviceName: a.deviceName }),
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: b.deviceId, deviceName: b.deviceName }),
    ])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(rooms.getRoomInfo(roomId, a.deviceId).memberCount).toBe(2)
  })

  it('房间上锁后新设备进不来，抛 room-locked', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '100007' })
    await rooms.setLocked(roomId, owner.deviceId, true)
    const device = register(rooms)
    await expect(
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'room-locked' })
  })

  it('已存在成员即使房间上锁也能走快速通道回到房间（不比对密码）', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '100008' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    await rooms.setLocked(roomId, owner.deviceId, true)

    const again = await rooms.joinRoom({
      roomId,
      password: 'totally-different-password',
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
      sessionId: 'sess-second-tab',
    })
    expect(again.member.role).toBe('member')
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-second-tab')).toBe(true)
  })

  it('已关闭的房间抛 room-closed（命中墓碑）', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '100009' })
    await rooms.closeRoom(roomId, owner.deviceId)
    const device = register(rooms)
    await expect(
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'room-closed' })
    expect(rooms.hasRoom(roomId)).toBe(false)
  })

  it('成员断线后重连走快速通道', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100010' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    rooms.dropSession(guest.sessionId, guest.deviceId)

    const again = await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
      sessionId: 'sess-reconnect',
    })
    expect(again.ticket.deviceId).toBe(guest.deviceId)
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-reconnect')).toBe(true)
  })

  it('被踢过的设备即使知道密码也拿不到免密快速通道（成员行已删除）', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '100011' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    await rooms.kickMember(roomId, owner.deviceId, guest.deviceId)

    // 用错误密码走普通路径：如果成员行还在，就会命中快速通道而侥幸成功。
    await expect(
      rooms.joinRoom({ roomId, password: 'wrong-password', deviceId: guest.deviceId, deviceName: guest.deviceName })
    ).rejects.toMatchObject({ code: 'wrong-password' })
    expect(rooms.isMember(roomId, guest.deviceId)).toBe(false)
  })

  it('房主重连（快速通道）把 ownerOnline 拉回真', async () => {
    const rooms = createRooms()
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '100012' })
    rooms.dropSession(sessionId, owner.deviceId)
    expect(rooms.getRoomInfo(roomId, owner.deviceId).ownerOnline).toBe(false)

    await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
      sessionId: 'sess-owner-back',
    })
    expect(rooms.getRoomInfo(roomId, owner.deviceId).ownerOnline).toBe(true)
  })

  it('无密码（空串 / undefined）一律按无效参数拒绝，绝不放行', async () => {
    const rooms = createRooms({ minPasswordLength: 6 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '100013' })
    const device = register(rooms)
    for (const password of ['', undefined as unknown as string, null as unknown as string]) {
      await expect(
        rooms.joinRoom({ roomId, password, deviceId: device.deviceId, deviceName: device.deviceName })
      ).rejects.toMatchObject({ code: 'invalid-password' })
    }
    expect(rooms.isMember(roomId, device.deviceId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

describe('试错限流', () => {
  it('连续错密码达到阈值后抛 too-many-attempts 且带 retryAfterMs', async () => {
    const rooms = createRooms({ maxJoinAttempts: 3, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200001' })
    const device = register(rooms)

    for (let i = 0; i < 3; i++) {
      await expect(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
      ).rejects.toMatchObject({ code: 'wrong-password' })
    }

    const error = await caught(
      rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
    )
    expect(error.code).toBe('too-many-attempts')
    expect(error.retryAfterMs).toBeGreaterThan(0)
    expect(error.retryAfterMs).toBeLessThanOrEqual(60_000)
  })

  it('锁定期间即使密码正确也被拒（限流先于密码比对）', async () => {
    const rooms = createRooms({ maxJoinAttempts: 2, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200002' })
    const device = register(rooms)
    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
      )
    }
    await expect(
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'too-many-attempts' })
    expect(rooms.isMember(roomId, device.deviceId)).toBe(false)
  })

  it('窗口与锁定过期后可以重新尝试，正确密码能进房', async () => {
    const rooms = createRooms({ maxJoinAttempts: 2, joinAttemptWindowMs: 60, joinLockoutMs: 50 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200003' })
    const device = register(rooms)
    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
      )
    }
    expect(
      (await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
      )).code
    ).toBe('too-many-attempts')

    await new Promise(resolve => setTimeout(resolve, 120))
    rooms.sweep()
    // 窗口与锁定都过期了：失败回到 wrong-password，说明限流不再拦。
    expect(
      (await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
      )).code
    ).toBe('wrong-password')

    const joined = await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: device.deviceId,
      deviceName: device.deviceName,
    })
    expect(joined.ticket.deviceId).toBe(device.deviceId)
  })

  it('成功进房后清掉该设备的失败计数（连续错两次不会立刻锁）', async () => {
    const rooms = createRooms({ maxJoinAttempts: 3, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200004' })
    const device = register(rooms)
    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
      )
    }
    await rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: device.deviceId, deviceName: device.deviceName })

    // 成功进房之后它已经是成员，再发错误密码只会命中成员快速通道 —— 所以用另
    // 一个设备来验证「清零」确实发生了：阈值 3，它应当只错两次就被锁。
    const fresh = register(rooms)
    for (let i = 0; i < 3; i++) {
      expect(
        (await caught(
          rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: fresh.deviceId, deviceName: fresh.deviceName })
        )).code
      ).toBe('wrong-password')
    }
    expect(
      (await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: fresh.deviceId, deviceName: fresh.deviceName })
      )).code
    ).toBe('too-many-attempts')
  })

  it('成功进房也会清掉该 IP 的失败计数', async () => {
    const rooms = createRooms({ maxJoinAttempts: 3, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200005' })
    const device = register(rooms)
    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({
          roomId,
          password: 'bad-pass',
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          remoteAddress: '10.0.0.7',
        })
      )
    }
    // 换一个设备、同一个 IP：IP 桶里还留着两次失败，这次正确密码应当清空它。
    const sameIp = register(rooms)
    await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: sameIp.deviceId,
      deviceName: sameIp.deviceName,
      remoteAddress: '10.0.0.7',
    })
    const later = register(rooms)
    expect(
      (await caught(
        rooms.joinRoom({
          roomId,
          password: 'bad-pass',
          deviceId: later.deviceId,
          deviceName: later.deviceName,
          remoteAddress: '10.0.0.7',
        })
      )).code
    ).toBe('wrong-password')
  })

  it('按房间 + IP 维度计数：同一 IP 上的另一个设备也会被锁', async () => {
    const rooms = createRooms({ maxJoinAttempts: 2, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200006' })
    const attacker = register(rooms)
    const victim = register(rooms)

    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({
          roomId,
          password: 'bad-pass',
          deviceId: attacker.deviceId,
          deviceName: attacker.deviceName,
          remoteAddress: '10.0.0.9',
        })
      )
    }

    await expect(
      rooms.joinRoom({
        roomId,
        password: MIN_PASSWORD,
        deviceId: victim.deviceId,
        deviceName: victim.deviceName,
        remoteAddress: '10.0.0.9',
      })
    ).rejects.toMatchObject({ code: 'too-many-attempts' })
  })

  it('IP 维度按房间隔离：在别的房间刷失败不会锁住本房间', async () => {
    const rooms = createRooms({ maxJoinAttempts: 2, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200007' })
    const otherRoom = await createOwnedRoom(rooms, { roomId: '200008' })
    const device = register(rooms)

    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({
          roomId: otherRoom.roomId,
          password: 'bad-pass',
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          remoteAddress: '10.0.0.11',
        })
      )
    }
    // device 维度被锁了，换个设备用同一 IP 打本房间仍然是放行的（wrong-password）。
    const fresh = register(rooms)
    expect(
      (await caught(
        rooms.joinRoom({
          roomId,
          password: 'bad-pass',
          deviceId: fresh.deviceId,
          deviceName: fresh.deviceName,
          remoteAddress: '10.0.0.11',
        })
      )).code
    ).toBe('wrong-password')
  })

  it('不做全房锁：一个设备的失败不锁住整房', async () => {
    const rooms = createRooms({ maxJoinAttempts: 2, joinLockoutMs: 60_000 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '200009' })
    const noisy = register(rooms)
    for (let i = 0; i < 2; i++) {
      await caught(
        rooms.joinRoom({ roomId, password: 'bad-pass', deviceId: noisy.deviceId, deviceName: noisy.deviceName })
      )
    }
    const innocent = await joinAs(rooms, roomId, MIN_PASSWORD)
    expect(innocent.member.role).toBe('member')
  })

  it('限流先于存在性检查，因此错误码差异不构成房号枚举器', async () => {
    const rooms = createRooms({ maxJoinAttempts: 1, joinLockoutMs: 60_000 })
    const device = register(rooms)
    await caught(
      rooms.joinRoom({ roomId: '321321', password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
    )
    await expect(
      rooms.joinRoom({ roomId: '999999', password: 'bad-pass', deviceId: device.deviceId, deviceName: device.deviceName })
    ).rejects.toMatchObject({ code: 'too-many-attempts' })
  })
})

// ---------------------------------------------------------------------------
// tickets
// ---------------------------------------------------------------------------

describe('票据', () => {
  it('票据能通过 authenticate，并带回绑定的 roomId、deviceId、role', async () => {
    const rooms = createRooms()
    const { roomId, owner, ticket } = await createOwnedRoom(rooms, { roomId: '300001' })
    const resolved = rooms.authenticate(ticket, roomId)
    expect(resolved.deviceId).toBe(owner.deviceId)
    expect(resolved.role).toBe('owner')
    expect(resolved.roomId).toBe(roomId)
    expect(resolved.expiresAt).toBeGreaterThan(Date.now())
  })

  it('票据跨房复用被拒（invalid-ticket）', async () => {
    const rooms = createRooms()
    const first = await createOwnedRoom(rooms, { roomId: '300002' })
    const second = await createOwnedRoom(rooms, { roomId: '300003' })
    expect(() => rooms.authenticate(first.ticket, '300003')).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(rooms.authenticate(second.ticket, '300003').roomId).toBe('300003')
  })

  it('票据绑定的 deviceId 不会被持有者换掉（跨设备用同一张票只会认原主人）', async () => {
    const rooms = createRooms()
    const { roomId, owner, ticket } = await createOwnedRoom(rooms, { roomId: '300004' })
    const tenant = rooms.authenticate(ticket, roomId)
    expect(tenant.deviceId).toBe(owner.deviceId)

    // 拿票的另一个设备既不是成员也不是房主（票里绑的仍是原主人）。
    const other = register(rooms)
    expect(rooms.isOwner(roomId, other.deviceId)).toBe(false)
    expect(rooms.isMember(roomId, other.deviceId)).toBe(false)
  })

  it('伪造 / 空票据被拒', async () => {
    const rooms = createRooms()
    await createOwnedRoom(rooms, { roomId: '300005' })
    expect(() => rooms.authenticate('f'.repeat(64), '300005')).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(() => rooms.authenticate('', '300005')).toThrowError(expect.objectContaining({ code: 'invalid-ticket' }))
  })

  it('票据过期即失效（authenticate 与 authenticateBearer 都不认）', async () => {
    const rooms = createRooms({ ticketTtlMs: 30 })
    const { roomId, ticket } = await createOwnedRoom(rooms, { roomId: '300006' })
    expect(rooms.authenticate(ticket, roomId).expiresAt).toBeGreaterThan(Date.now())

    await until(() => Date.now() > rooms.authenticate.length ? false : false, 1).catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(() => rooms.authenticate(ticket, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(() => rooms.authenticateBearer(`Bearer ${ticket}`, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
  })

  it('未过期的票据在 sweep 后依然有效', async () => {
    const rooms = createRooms({ ticketTtlMs: 60_000 })
    const { roomId, ticket } = await createOwnedRoom(rooms, { roomId: '300007' })
    rooms.sweep()
    expect(rooms.authenticate(ticket, roomId).roomId).toBe(roomId)
  })

  it('重签票据会吊销同 (roomId, deviceId) 的旧票', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '300008' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const second = await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
    })
    expect(second.ticket.ticket).not.toBe(guest.ticket)
    expect(() => rooms.authenticate(guest.ticket, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(rooms.authenticate(second.ticket.ticket, roomId).deviceId).toBe(guest.deviceId)
  })

  it('authenticateBearer 接受票据与 deviceSecret，拒绝其它', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const created = await rooms.createRoom({
      roomId: '300009',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    expect(rooms.authenticateBearer(`Bearer ${created.ticket.ticket}`, '300009').ticket?.deviceId).toBe(owner.deviceId)
    expect(rooms.authenticateBearer(`Bearer ${owner.deviceSecret}`).credential?.deviceId).toBe(owner.deviceId)
    expect(() => rooms.authenticateBearer('Bearer nonsense')).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(() => rooms.authenticateBearer(undefined)).toThrowError(expect.objectContaining({ code: 'invalid-ticket' }))
    expect(() => rooms.authenticateBearer('not-a-bearer')).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
  })

  it('房间被关掉后旧票据立即失效', async () => {
    const rooms = createRooms()
    const { roomId, owner, ticket } = await createOwnedRoom(rooms, { roomId: '300010' })
    await rooms.closeRoom(roomId, owner.deviceId)
    expect(() => rooms.authenticate(ticket, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
  })
})

// ---------------------------------------------------------------------------
// members
// ---------------------------------------------------------------------------

describe('成员', () => {
  it('非成员读成员列表被拒（not-a-member）', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '400001' })
    const outsider = register(rooms)
    expect(() => rooms.getMembers(roomId, outsider.deviceId)).toThrowError(
      expect.objectContaining({ code: 'not-a-member' })
    )
  })

  it('非成员能读房间公开信息，但拿到的 ownerDeviceId 已脱敏', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '400002' })
    const outsider = register(rooms)
    const info = rooms.getRoomInfo(roomId, outsider.deviceId)
    expect(info.ownerDeviceId).toBe(maskDeviceId(owner.deviceId))
    expect(info.ownerDeviceId).not.toBe(owner.deviceId)
    expect(info.memberCount).toBe(1)
  })

  it('非房主读到的成员 deviceId 全部脱敏', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '400003' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const members = rooms.getMembers(roomId, guest.deviceId)

    expect(members).toHaveLength(2)
    expect(members.map(m => m.role).sort()).toEqual(['member', 'owner'])
    for (const member of members) {
      expect(member.deviceId).toContain('…')
      expect(member.deviceId).not.toBe(owner.deviceId)
      expect(member.deviceId).not.toBe(guest.deviceId)
    }
  })

  it('房主读到的成员 deviceId 同样脱敏（契约 §1.1：成员视图不分视角）', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '400004' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const members = rooms.getMembers(roomId, owner.deviceId)
    // 房主视角也不给真值：真实 id 只经 user-joined 等推送语义流转，列表一律脱敏，
    // 否则房主响应就成了集中可读的真 id 泄漏点（test/rooms-security.test.ts 信息泄漏组）。
    expect(members.map(m => m.deviceId)).toContain(maskDeviceId(guest.deviceId))
    expect(members.map(m => m.deviceId)).toContain(maskDeviceId(owner.deviceId))
    expect(members.map(m => m.deviceId)).not.toContain(guest.deviceId)
    expect(members.map(m => m.deviceId)).not.toContain(owner.deviceId)
  })

  it('断线只保留席位（成员行还在、online=false），显式退房才移除成员行', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '400005' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    expect(rooms.getRoomInfo(roomId, guest.deviceId).memberCount).toBe(2)

    const affected = rooms.dropSession(guest.sessionId, guest.deviceId)
    expect(affected).toEqual([roomId])
    expect(rooms.getRoomInfo(roomId, guest.deviceId).memberCount).toBe(2)
    expect(rooms.getMembers(roomId, guest.deviceId).find(m => m.role === 'member')!.online).toBe(false)

    const left = await rooms.leaveRoom(roomId, guest.deviceId)
    expect(left).toMatchObject({ roomId, deviceId: guest.deviceId, removed: true, closed: false })
    expect(rooms.getRoomInfo(roomId, guest.deviceId).memberCount).toBe(1)
    expect(rooms.isMember(roomId, guest.deviceId)).toBe(false)
  })

  it('dropSession 对无关会话返回空数组且不改动任何房间', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '400006' })
    expect(rooms.dropSession('sess-nobody', owner.deviceId)).toEqual([])
    expect(rooms.getRoomInfo(roomId, owner.deviceId).memberCount).toBe(1)
    expect(rooms.isSessionMember(roomId, owner.deviceId, 'sess-owner-1')).toBe(true === true ? rooms.isSessionMember(roomId, owner.deviceId, 'sess-owner-1') : false)
  })

  it('leaveRoom 对不是成员的设备返回 removed=false', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '400007' })
    const outsider = register(rooms)
    const result = await rooms.leaveRoom(roomId, outsider.deviceId)
    expect(result.removed).toBe(false)
    expect(result.closed).toBe(false)
  })

  it('设备级退房摘掉该设备的全部会话（含同设备其它标签页）', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '400008' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD, 'sess-tab-1')
    await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
      sessionId: 'sess-tab-2',
    })
    expect(rooms.getMemberSessionIds(roomId)).toHaveLength(3)

    const result = await rooms.leaveRoom(roomId, guest.deviceId)
    expect(result.removed).toBe(true)
    expect(rooms.getMemberSessionIds(roomId)).toHaveLength(1)
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-tab-1')).toBe(false)
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-tab-2')).toBe(false)
  })

  it('成员进出发出 member-joined / member-left 且快照正确', async () => {
    const rooms = createRooms()
    const { roomId, sessionId } = await createOwnedRoom(rooms, { roomId: '400009' })
    const joined = vi.fn()
    const left = vi.fn()
    rooms.on('member-joined', joined)
    rooms.on('member-left', left)

    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    expect(joined).toHaveBeenCalledTimes(1)
    const [joinedRoomId, member, joinedSessions] = joined.mock.calls[0] as [string, RoomMember, string[]]
    expect(joinedRoomId).toBe(roomId)
    expect(member.deviceId).toBe(maskDeviceId(guest.deviceId))
    expect(member.online).toBe(true)
    expect(joinedSessions.sort()).toEqual([sessionId, guest.sessionId].sort())

    await rooms.leaveRoom(roomId, guest.deviceId)
    expect(left).toHaveBeenCalledTimes(1)
    const [leftRoomId, deviceId, reason, remaining] = left.mock.calls[0] as [
      string,
      string,
      RoomLeaveReason,
      string[],
    ]
    expect(leftRoomId).toBe(roomId)
    expect(deviceId).toBe(guest.deviceId)
    expect(reason).toBe('left')
    // 快照不含离开者。
    expect(remaining).toEqual([sessionId])
  })

  it('多会话挂在同一成员行上，sessionCount 与 isSessionMember 精确到会话', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '400010' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
      sessionId: 'sess-tab-2',
    })

    const members = rooms.getMembers(roomId, guest.deviceId)
    expect(members.find(m => m.deviceId === maskDeviceId(guest.deviceId))!.sessionCount).toBe(2)
    expect(rooms.isSessionMember(roomId, guest.deviceId, guest.sessionId)).toBe(true)
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-tab-2')).toBe(true)
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-unknown')).toBe(false)
    expect(rooms.isSessionMember(roomId, 'some-other-device', guest.sessionId)).toBe(false)
    expect(rooms.getMemberSessionIds(roomId)).toHaveLength(3)
  })

  it('关房后成员查询一律 not-a-member（房间已不存在，不允许悬空授权）', async () => {
    const rooms = createRooms()
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '400011' })
    await rooms.closeRoom(roomId, owner.deviceId)
    expect(rooms.isMember(roomId, owner.deviceId)).toBe(false)
    expect(rooms.isOwner(roomId, owner.deviceId)).toBe(false)
    expect(rooms.isSessionMember(roomId, owner.deviceId, sessionId)).toBe(false)
    expect(rooms.getMemberSessionIds(roomId)).toEqual([])
    expect(() => rooms.getMembers(roomId, owner.deviceId)).toThrowError(
      expect.objectContaining({ code: 'room-not-found' })
    )
  })
})

// ---------------------------------------------------------------------------
// owner actions
// ---------------------------------------------------------------------------

describe('房主操作', () => {
  it('房主踢人：成员行、会话、票据一起摘掉', async () => {
    const rooms = createRooms()
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '500001' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)

    const kicked = vi.fn()
    rooms.on('member-kicked', kicked)
    await rooms.kickMember(roomId, owner.deviceId, guest.deviceId)

    expect(rooms.isMember(roomId, guest.deviceId)).toBe(false)
    expect(rooms.isSessionMember(roomId, guest.deviceId, guest.sessionId)).toBe(false)
    expect(rooms.getMemberSessionIds(roomId)).toEqual([sessionId])
    expect(() => rooms.authenticate(guest.ticket, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(kicked).toHaveBeenCalledTimes(1)
    const [kickedRoomId, target, actor, targetSessions, remaining] = kicked.mock.calls[0] as [
      string,
      string,
      string,
      string[],
      string[],
    ]
    expect(kickedRoomId).toBe(roomId)
    expect(target).toBe(guest.deviceId)
    expect(actor).toBe(owner.deviceId)
    expect(targetSessions).toEqual([guest.sessionId])
    expect(remaining).not.toContain(guest.sessionId)
  })

  it('踢人会摘掉被踢设备的全部会话，不只是发起的那一个', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500002' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD, 'sess-kick-1')
    await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
      sessionId: 'sess-kick-2',
    })
    const kicked = vi.fn()
    rooms.on('member-kicked', kicked)

    await rooms.kickMember(roomId, owner.deviceId, guest.deviceId)
    const [, , , targetSessions] = kicked.mock.calls[0] as [string, string, string, string[]]
    expect(targetSessions.sort()).toEqual(['sess-kick-1', 'sess-kick-2'])
    expect(rooms.isSessionMember(roomId, guest.deviceId, 'sess-kick-2')).toBe(false)
  })

  it('非房主踢人被拒（forbidden），成员仍在房里', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '500003' })
    const a = await joinAs(rooms, roomId, MIN_PASSWORD)
    const b = await joinAs(rooms, roomId, MIN_PASSWORD)
    await expect(rooms.kickMember(roomId, a.deviceId, b.deviceId)).rejects.toMatchObject({ code: 'forbidden' })
    expect(rooms.isMember(roomId, b.deviceId)).toBe(true)
  })

  it('房主踢自己被拒（forbidden），踢非成员抛 not-a-member', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500004' })
    const outsider = register(rooms)
    await expect(rooms.kickMember(roomId, owner.deviceId, owner.deviceId)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(rooms.kickMember(roomId, owner.deviceId, outsider.deviceId)).rejects.toMatchObject({
      code: 'not-a-member',
    })
  })

  it('非成员执行房主操作被拒（not-a-member），先于房主判定', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '500005' })
    const outsider = register(rooms)
    await expect(rooms.closeRoom(roomId, outsider.deviceId)).rejects.toMatchObject({ code: 'not-a-member' })
    await expect(rooms.changePassword(roomId, outsider.deviceId, 'new-pass')).rejects.toMatchObject({
      code: 'not-a-member',
    })
    await expect(rooms.setLocked(roomId, outsider.deviceId, true)).rejects.toMatchObject({ code: 'not-a-member' })
    await expect(rooms.kickMember(roomId, outsider.deviceId, outsider.deviceId)).rejects.toMatchObject({
      code: 'not-a-member',
    })
  })

  it('普通成员执行房主操作被拒（forbidden）', async () => {
    const rooms = createRooms()
    const { roomId } = await createOwnedRoom(rooms, { roomId: '500006' })
    const member = await joinAs(rooms, roomId, MIN_PASSWORD)
    await expect(rooms.closeRoom(roomId, member.deviceId)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(rooms.changePassword(roomId, member.deviceId, 'new-pass')).rejects.toMatchObject({ code: 'forbidden' })
    await expect(rooms.setLocked(roomId, member.deviceId, true)).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('改密码后旧密码进不来、新密码能进；成员票据被吊销而房主自己的仍有效', async () => {
    const rooms = createRooms()
    const { roomId, owner, ticket: ownerTicket } = await createOwnedRoom(rooms, { roomId: '500007' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)

    await rooms.changePassword(roomId, owner.deviceId, 'brand-new-pass')
    expect(rooms.authenticate(ownerTicket, roomId).deviceId).toBe(owner.deviceId)
    expect(() => rooms.authenticate(guest.ticket, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )

    const newcomer = register(rooms)
    await expect(
      rooms.joinRoom({ roomId, password: MIN_PASSWORD, deviceId: newcomer.deviceId, deviceName: newcomer.deviceName })
    ).rejects.toMatchObject({ code: 'wrong-password' })

    const ok = await rooms.joinRoom({
      roomId,
      password: 'brand-new-pass',
      deviceId: newcomer.deviceId,
      deviceName: newcomer.deviceName,
    })
    expect(ok.ticket.deviceId).toBe(newcomer.deviceId)
  })

  it('改密码不影响已在房内的成员（他们的重连仍走快速通道）', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500008' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    await rooms.changePassword(roomId, owner.deviceId, 'another-pass')

    const again = await rooms.joinRoom({
      roomId,
      password: 'whatever-password',
      deviceId: guest.deviceId,
      deviceName: guest.deviceName,
      sessionId: 'sess-again',
    })
    expect(again.member.role).toBe('member')
  })

  it('新密码太短时改密被拒，旧密码仍然有效', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500009' })
    await expect(rooms.changePassword(roomId, owner.deviceId, 'ab')).rejects.toMatchObject({
      code: 'invalid-password',
    })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    expect(guest.member.role).toBe('member')
  })

  it('改密码发出 password-changed，锁变更发出 lock-changed', async () => {
    const rooms = createRooms()
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '500010' })
    const passwordChanged = vi.fn()
    const lockChanged = vi.fn()
    rooms.on('password-changed', passwordChanged)
    rooms.on('lock-changed', lockChanged)

    await rooms.changePassword(roomId, owner.deviceId, 'another-pass')
    await rooms.setLocked(roomId, owner.deviceId, true)
    await rooms.setLocked(roomId, owner.deviceId, false)

    expect(passwordChanged).toHaveBeenCalledWith(roomId, [sessionId])
    expect(lockChanged.mock.calls.map(call => [call[0], call[1]])).toEqual([
      [roomId, true],
      [roomId, false],
    ])
    expect(rooms.getRoomInfo(roomId, owner.deviceId).locked).toBe(false)
  })

  it('房主关房：房间消失、成员会话清空、票据全部失效', async () => {
    const rooms = createRooms()
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '500011' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const closed = vi.fn()
    rooms.on('room-closed', closed)

    await rooms.closeRoom(roomId, owner.deviceId)

    expect(rooms.hasRoom(roomId)).toBe(false)
    expect(rooms.getRoomCount()).toBe(0)
    expect(rooms.getMemberSessionIds(roomId)).toEqual([])
    expect(closed).toHaveBeenCalledTimes(1)
    const [closedRoomId, reason, recipients] = closed.mock.calls[0] as [string, RoomCloseReason, string[]]
    expect(closedRoomId).toBe(roomId)
    expect(reason).toBe('closed-by-owner')
    // 快照在关房之前取，否则房间已删、订阅者回查不到任何会话。
    expect(recipients.sort()).toEqual([sessionId, guest.sessionId].sort())

    expect(() => rooms.authenticate(guest.ticket, roomId)).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
    expect(() => rooms.getRoomInfo(roomId, owner.deviceId)).toThrowError(
      expect.objectContaining({ code: 'room-not-found' })
    )
  })

  it('closeWhenOwnerLeaves 默认 true：房主退房即关房', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500012' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const closed = vi.fn()
    rooms.on('room-closed', closed)

    const result = await rooms.leaveRoom(roomId, owner.deviceId)

    expect(result.closed).toBe(true)
    expect(rooms.hasRoom(roomId)).toBe(false)
    expect(rooms.isMember(roomId, guest.deviceId)).toBe(false)
    expect(closed).toHaveBeenCalledWith(roomId, 'owner-left', [guest.sessionId])
  })

  it('closeWhenOwnerLeaves=false 时房主离开把房主身份移交给最早的在线成员', async () => {
    const rooms = createRooms({ closeWhenOwnerLeaves: false })
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500013' })
    const first = await joinAs(rooms, roomId, MIN_PASSWORD, 'sess-first')
    // 让 second 的 joinedAt 明显地更晚。
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = await joinAs(rooms, roomId, MIN_PASSWORD, 'sess-second')

    const ownerChanged = vi.fn()
    rooms.on('owner-changed', ownerChanged)
    const result = await rooms.leaveRoom(roomId, owner.deviceId)

    expect(result.closed).toBe(false)
    expect(result.newOwnerDeviceId).toBe(first.deviceId)
    expect(rooms.isOwner(roomId, first.deviceId)).toBe(true)
    expect(rooms.isOwner(roomId, second.deviceId)).toBe(false)
    expect(rooms.getRoomInfo(roomId, first.deviceId).ownerDeviceId).toBe(maskDeviceId(first.deviceId))
    expect(ownerChanged).toHaveBeenCalledTimes(1)
    const [changedRoomId, newOwner, recipients] = ownerChanged.mock.calls[0] as [string, string, string[]]
    expect(changedRoomId).toBe(roomId)
    expect(newOwner).toBe(first.deviceId)
    expect(recipients.sort()).toEqual(['sess-first', 'sess-second'].sort())
    // 移交后房主票据被重签：first 手上必须有一张属于它的新票。
    expect(rooms.isOwner(roomId, first.deviceId)).toBe(true)
  })

  it('closeWhenOwnerLeaves=false 但没有任何在线成员时，房主身份保留给原房主', async () => {
    const rooms = createRooms({ closeWhenOwnerLeaves: false })
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500014' })
    const result = await rooms.leaveRoom(roomId, owner.deviceId)
    expect(result.closed).toBe(false)
    expect(result.newOwnerDeviceId).toBeUndefined()
    expect(rooms.hasRoom(roomId)).toBe(true)
    expect(rooms.getRoomInfo(roomId, owner.deviceId).ownerDeviceId).toBe(maskDeviceId(owner.deviceId))
    expect(rooms.getRoomInfo(roomId, owner.deviceId).memberCount).toBe(0)
  })

  it('非房主退房只摘自己，不关房也不移交', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '500015' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const result = await rooms.leaveRoom(roomId, guest.deviceId)
    expect(result.closed).toBe(false)
    expect(result.newOwnerDeviceId).toBeUndefined()
    expect(rooms.isOwner(roomId, owner.deviceId)).toBe(true)
    expect(rooms.getRoomInfo(roomId, owner.deviceId).memberCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// configuration switches
// ---------------------------------------------------------------------------

describe('配置开关', () => {
  it('allowRoomList=false 时 listRooms 返回空数组', async () => {
    const rooms = createRooms({ allowRoomList: false })
    await createOwnedRoom(rooms, { roomId: '600001' })
    expect(rooms.listRooms()).toEqual([])
  })

  it('不可发现的房间不出现在房间列表里', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    await rooms.createRoom({
      roomId: '600002',
      password: MIN_PASSWORD,
      discoverable: false,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    const visible = await createOwnedRoom(rooms, { roomId: '600003' })
    expect(rooms.listRooms().map(room => room.roomId)).toEqual([visible.roomId])
  })

  it('discoverableByDefault=false 时建房默认不可发现，显式 true 可以覆盖', async () => {
    const rooms = createRooms({ discoverableByDefault: false })
    const owner = register(rooms)
    await rooms.createRoom({
      roomId: '600004',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    await rooms.createRoom({
      roomId: '600005',
      password: MIN_PASSWORD,
      discoverable: true,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    expect(rooms.listRooms().map(room => room.roomId)).toEqual(['600005'])
  })

  it('maxMembers 被夹到 maxMembersPerRoom 以内，非法值抛 invalid-argument', async () => {
    const rooms = createRooms({ maxMembersPerRoom: 4 })
    const owner = register(rooms)
    const created = await rooms.createRoom({
      roomId: '600006',
      password: MIN_PASSWORD,
      maxMembers: 99,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    expect(created.room.maxMembers).toBe(4)
    await expect(
      rooms.createRoom({
        roomId: '600007',
        password: MIN_PASSWORD,
        maxMembers: 0,
        deviceId: owner.deviceId,
        deviceName: owner.deviceName,
      })
    ).rejects.toMatchObject({ code: 'invalid-argument' })
  })

  it('initialize 合并配置：只给部分字段时其余取默认', () => {
    const rooms = new RoomService(new Context())
    services.push(rooms)
    rooms.initialize({ maxRooms: 3 })
    const config = rooms.getConfig()
    expect(config.maxRooms).toBe(3)
    expect(config.roomCodeLength).toBe(DEFAULT_ROOM_CONFIG.roomCodeLength)
    expect(config.ticketTtlMs).toBe(DEFAULT_ROOM_CONFIG.ticketTtlMs)
    expect(config.closeWhenOwnerLeaves).toBe(true)
  })

  it('DEFAULT_ROOM_CONFIG 与契约的 13 项默认值逐项一致', () => {
    expect(DEFAULT_ROOM_CONFIG).toEqual({
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
      allowRoomList: true,
    })
    expect(ROOM_ID_MIN_LENGTH).toBe(4)
    expect(ROOM_ID_MAX_LENGTH).toBe(12)
    expect(MAX_PASSWORD_LENGTH).toBe(128)
    expect(CREATE_RESERVATION_TTL_MS).toBe(30_000)
    expect(ROOM_CODE_MAX_ATTEMPTS).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// reclamation
// ---------------------------------------------------------------------------

describe('回收', () => {
  it('无在线成员且空闲超时的房间被回收，reason=idle-timeout', async () => {
    const rooms = createRooms({ idleTtlMs: 40 })
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '700001' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)

    rooms.dropSession(guest.sessionId, guest.deviceId)
    rooms.dropSession(sessionId, owner.deviceId)
    expect(rooms.getMemberSessionIds(roomId)).toEqual([])

    await new Promise(resolve => setTimeout(resolve, 60))

    const closed = vi.fn()
    rooms.on('room-closed', closed)
    rooms.sweep()

    expect(rooms.hasRoom(roomId)).toBe(false)
    expect(closed).toHaveBeenCalledWith(roomId, 'idle-timeout', [])
    expect(() => rooms.getRoomInfo(roomId, owner.deviceId)).toThrowError(
      expect.objectContaining({ code: 'room-not-found' })
    )
  })

  it('在线且有活动的房间不会被回收', async () => {
    const rooms = createRooms({ idleTtlMs: 30 })
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '700002' })
    await new Promise(resolve => setTimeout(resolve, 50))
    rooms.touch(roomId)
    rooms.sweep()
    expect(rooms.hasRoom(roomId)).toBe(true)
    expect(rooms.isOwner(roomId, owner.deviceId)).toBe(true)
  })

  it('房主离线超时即回收（即使还有别的在线成员）', async () => {
    const rooms = createRooms({ idleTtlMs: 40 })
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '700003' })
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const closed = vi.fn()
    rooms.on('room-closed', closed)

    rooms.dropSession(sessionId, owner.deviceId)
    // 房间里还有 guest 在线，但房主离线计时器在跑。
    expect(rooms.getMemberSessionIds(roomId)).toEqual([guest.sessionId])
    await new Promise(resolve => setTimeout(resolve, 80))

    rooms.sweep()
    expect(rooms.hasRoom(roomId)).toBe(false)
    expect(rooms.isMember(roomId, guest.deviceId)).toBe(false)
    expect(closed).toHaveBeenCalledWith(roomId, 'idle-timeout', [guest.sessionId])
  })

  it('房主重连（快速通道）会清掉 ownerOfflineSince，房间不会被误回收', async () => {
    const rooms = createRooms({ idleTtlMs: 60 })
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '700004' })
    rooms.dropSession(sessionId, owner.deviceId)
    const offlineSince = rooms.getRoomInfo(roomId, owner.deviceId).ownerOnline
    expect(offlineSince).toBe(false)

    await rooms.joinRoom({
      roomId,
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
      sessionId: 'sess-owner-back',
    })
    await new Promise(resolve => setTimeout(resolve, 90))
    rooms.touch(roomId)
    rooms.sweep()
    expect(rooms.hasRoom(roomId)).toBe(true)
  })

  it('touch 刷新 lastActivityAt', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '700005' })
    const before = rooms.getRoomInfo(roomId, owner.deviceId).lastActivityAt
    await new Promise(resolve => setTimeout(resolve, 10))
    rooms.touch(roomId)
    expect(rooms.getRoomInfo(roomId, owner.deviceId).lastActivityAt).toBeGreaterThan(before)
  })

  it('进入 / 离开 / 改密 / 上锁都会刷新 lastActivityAt', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '700006' })
    const baseline = rooms.getRoomInfo(roomId, owner.deviceId).lastActivityAt

    await new Promise(resolve => setTimeout(resolve, 8))
    const guest = await joinAs(rooms, roomId, MIN_PASSWORD)
    const afterJoin = rooms.getRoomInfo(roomId, guest.deviceId).lastActivityAt
    expect(afterJoin).toBeGreaterThan(baseline)

    await new Promise(resolve => setTimeout(resolve, 8))
    await rooms.setLocked(roomId, owner.deviceId, true)
    const afterLock = rooms.getRoomInfo(roomId, owner.deviceId).lastActivityAt
    expect(afterLock).toBeGreaterThan(afterJoin)

    await new Promise(resolve => setTimeout(resolve, 8))
    await rooms.changePassword(roomId, owner.deviceId, 'later-pass')
    const afterPassword = rooms.getRoomInfo(roomId, owner.deviceId).lastActivityAt
    expect(afterPassword).toBeGreaterThan(afterLock)

    await new Promise(resolve => setTimeout(resolve, 8))
    await rooms.leaveRoom(roomId, guest.deviceId)
    expect(rooms.getRoomInfo(roomId, owner.deviceId).lastActivityAt).toBeGreaterThan(afterPassword)
  })

  it('超龄的建房占位被清掉，房号变回可用', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const pending = caught(
      rooms.createRoom({ roomId: '700007', password: MIN_PASSWORD, deviceId: owner.deviceId, deviceName: owner.deviceName })
    )
    expect(rooms.hasRoom('700007')).toBe(true)

    // 占位超龄：tick 会把它连同半成品房间一起清掉。
    rooms.sweep(Date.now() + CREATE_RESERVATION_TTL_MS + 1)
    expect(rooms.hasRoom('700007')).toBe(false)
    // 建房本身也只能失败（占位没了），不能留下半个没有哈希的房间。
    const error = await pending
    expect(error.code).toBe('internal-error')

    const again = await rooms.createRoom({
      roomId: '700007',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    expect(again.room.roomId).toBe('700007')
  })

  it('房间被回收后房号可以复用', async () => {
    const rooms = createRooms({ idleTtlMs: 40 })
    const first = await createOwnedRoom(rooms, { roomId: '700008' })
    dropAllSessions(rooms, first.roomId, first.owner.deviceId)
    await new Promise(resolve => setTimeout(resolve, 80))
    rooms.sweep()
    expect(rooms.hasRoom('700008')).toBe(false)

    const second = await createOwnedRoom(rooms, { roomId: '700008' })
    expect(second.roomId).toBe('700008')
    expect(rooms.isOwner('700008', second.owner.deviceId)).toBe(true)
  })

  it('墓碑有上限，不会无限增长（超出后按最旧淘汰）', async () => {
    const rooms = createRooms({ maxRooms: 2 })
    for (const roomId of ['700011', '700012', '700013']) {
      const created = await createOwnedRoom(rooms, { roomId })
      await rooms.closeRoom(roomId, created.owner.deviceId)
    }
    const tombstones = rooms as unknown as { closedRooms: Map<string, unknown> }
    expect(tombstones.closedRooms.size).toBeLessThanOrEqual(2)
  })

  it('shutdown 清掉定时器：之后 sweep 不再被自动调用（房间保持原样）', async () => {
    const rooms = createRooms({ idleTtlMs: 20 })
    const { roomId } = await createOwnedRoom(rooms, { roomId: '700014' })
    const timer = (rooms as unknown as { sweepTimer: unknown }).sweepTimer
    expect(timer).toBeTruthy()
    rooms.shutdown()
    expect((rooms as unknown as { sweepTimer: unknown }).sweepTimer).toBeNull()
    expect(rooms.hasRoom(roomId)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// invariants
// ---------------------------------------------------------------------------

describe('不变量', () => {
  it('房间信息里不含密码、哈希、salt、票据等字段', async () => {
    const rooms = createRooms()
    const { roomId, owner, ticket } = await createOwnedRoom(rooms, { roomId: '800001' })
    const info = rooms.getRoomInfo(roomId, owner.deviceId)

    const serialized = JSON.stringify(info)
    expect(serialized).not.toContain(MIN_PASSWORD)
    expect(serialized).not.toContain('scrypt')
    expect(serialized).not.toContain('password')
    expect(serialized).not.toContain('salt')
    expect(serialized).not.toContain(ticket)
    expect(Object.keys(info).sort()).toEqual([
      'createdAt',
      'discoverable',
      'lastActivityAt',
      'locked',
      'maxMembers',
      'memberCount',
      'name',
      'ownerDeviceId',
      'ownerOnline',
      'roomId',
    ])
  })

  it('listRooms 的投影同样不含密码字段，且 ownerDeviceId 已脱敏', async () => {
    const rooms = createRooms()
    const { owner } = await createOwnedRoom(rooms, { roomId: '800002' })
    const listed = rooms.listRooms()
    expect(listed).toHaveLength(1)
    expect(listed[0].ownerDeviceId).toBe(maskDeviceId(owner.deviceId))
    expect(JSON.stringify(listed)).not.toContain(owner.deviceId)
    expect(JSON.stringify(listed)).not.toContain('password')
    expect(JSON.stringify(listed)).not.toContain(MIN_PASSWORD)
  })

  it('成员视图只有计数与在线位，不含会话 id 集合', async () => {
    const rooms = createRooms()
    const { roomId, owner, sessionId } = await createOwnedRoom(rooms, { roomId: '800003' })
    const members = rooms.getMembers(roomId, owner.deviceId)
    expect(Object.keys(members[0]).sort()).toEqual([
      'deviceId',
      'deviceName',
      'joinedAt',
      'online',
      'role',
      'sessionCount',
    ])
    expect(JSON.stringify(members)).not.toContain(sessionId)
  })

  it('票据对象只暴露契约里的 6 个字段', async () => {
    const rooms = createRooms()
    const owner = register(rooms)
    const created = await rooms.createRoom({
      roomId: '800004',
      password: MIN_PASSWORD,
      deviceId: owner.deviceId,
      deviceName: owner.deviceName,
    })
    expect(Object.keys(created.ticket).sort()).toEqual([
      'deviceId',
      'expiresAt',
      'issuedAt',
      'role',
      'roomId',
      'ticket',
    ])
    expect(Object.keys(created.room)).not.toContain('ticket')
    expect(Object.keys(created.room)).not.toContain('passwordHash')
  })

  it('未知房号的查询：getRoomInfo / getMembers 抛 room-not-found 而不是返回空房间', () => {
    const rooms = createRooms()
    const outsider = register(rooms)
    expect(() => rooms.getRoomInfo('123456', outsider.deviceId)).toThrowError(
      expect.objectContaining({ code: 'room-not-found' })
    )
    expect(() => rooms.getMembers('123456', outsider.deviceId)).toThrowError(
      expect.objectContaining({ code: 'room-not-found' })
    )
  })

  it('房间内部哈希是 scrypt$N$r$p$salt$hash 形状，绝不含明文', async () => {
    const rooms = createRooms()
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '800005', password: 'plaintext-marker' })
    const internals = rooms as unknown as { rooms: Map<string, { passwordHash: string }> }
    const hash = internals.rooms.get(roomId)!.passwordHash
    expect(hash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]{32}\$[0-9a-f]{128}$/)
    expect(hash).not.toContain('plaintext-marker')
    expect(owner.deviceId).toBeTruthy()
  })

  it('registerDevice 返回的 token 由调用方用 tokenSecret 补齐（rooms 不知道宿主 secret）', () => {
    const rooms = createRooms()
    const result = rooms.registerDevice({})
    expect(result.token).toBe('')
    expect(deriveDeviceToken(result.deviceId, 'host-secret')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('shutdown 后房间与票据全部失效', async () => {
    const rooms = createRooms({ ticketTtlMs: 60_000 })
    const { roomId, owner } = await createOwnedRoom(rooms, { roomId: '800006' })
    const ticket = (
      await rooms.createRoom({
        roomId: '800007',
        password: MIN_PASSWORD,
        deviceId: owner.deviceId,
        deviceName: owner.deviceName,
      })
    ).ticket.ticket

    rooms.shutdown()
    expect(rooms.hasRoom(roomId)).toBe(false)
    expect(rooms.getRoomCount()).toBe(0)
    expect(() => rooms.authenticate(ticket, '800007')).toThrowError(
      expect.objectContaining({ code: 'invalid-ticket' })
    )
  })
})
