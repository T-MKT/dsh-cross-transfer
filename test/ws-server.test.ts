/**
 * src/ws-server.ts 集成测试。
 *
 * 通过真实的 HTTP upgrade + ws 客户端驱动 WSServer：
 * WSServer 使用 noServer 模式，测试自行挂一个 http server，
 * 把 upgrade 事件转交给 wsServer.handleUpgrade()，与 src/index.ts 的接线方式一致。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server as HTTPServer } from 'http'
import type { AddressInfo } from 'net'
import { createHash } from 'crypto'
import { WebSocket } from 'ws'
import { WSServer, type WSMessage, type WSServerConfig, type WSSession } from '../src/ws-server.js'
import { RoomService } from '../src/rooms.js'
import { ChatService } from '../src/chat.js'
import { RoomGateway } from '../src/index.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

async function until(cond: () => boolean, timeoutMs = 4000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await sleep(20)
  }
}

/** 与 src/index.ts:112 相同的 token 生成方式 */
function makeToken(deviceId: string, secret: string): string {
  return createHash('sha256').update(`${deviceId}:${secret}`).digest('hex')
}

interface CloseInfo {
  code: number
  reason: string
}

type MsgWaiter = {
  pred: (m: WSMessage) => boolean
  resolve: (m: WSMessage) => void
  timer: ReturnType<typeof setTimeout>
}

class TestClient {
  readonly ws: WebSocket
  readonly messages: WSMessage[] = []
  readonly errors: Error[] = []
  closeInfo: CloseInfo | null = null
  private cursor = 0
  private msgWaiters: MsgWaiter[] = []
  private closeWaiters: Array<{ resolve: (c: CloseInfo) => void; timer: ReturnType<typeof setTimeout> }> = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('message', data => {
      let msg: WSMessage
      try {
        msg = JSON.parse(data.toString())
      } catch {
        msg = { type: '<unparsable>', payload: data.toString() }
      }
      this.messages.push(msg)
      this.pump()
    })
    this.ws.on('error', err => this.errors.push(err as Error))
    this.ws.on('close', (code, reason) => {
      this.closeInfo = { code, reason: reason.toString() }
      for (const w of this.closeWaiters.splice(0)) {
        clearTimeout(w.timer)
        w.resolve(this.closeInfo)
      }
    })
  }

  static open(baseUrl: string, params: Record<string, string> = {}): Promise<TestClient> {
    const url = new URL(baseUrl)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const client = new TestClient(url.toString())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('client open timed out')), 5000)
      client.ws.once('open', () => {
        clearTimeout(timer)
        resolve(client)
      })
      client.ws.once('error', err => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  /** 从游标开始按序取第一条匹配的消息（先查已收到的，再挂起等待） */
  waitFor(pred: (m: WSMessage) => boolean, timeoutMs = 4000): Promise<WSMessage> {
    for (let i = this.cursor; i < this.messages.length; i++) {
      if (pred(this.messages[i])) {
        this.cursor = i + 1
        return Promise.resolve(this.messages[i])
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.msgWaiters.findIndex(w => w.timer === timer)
        if (idx >= 0) this.msgWaiters.splice(idx, 1)
        reject(new Error(`Timed out waiting for message; received=${JSON.stringify(this.messages)}`))
      }, timeoutMs)
      this.msgWaiters.push({ pred, resolve, timer })
    })
  }

  waitForClose(timeoutMs = 4000): Promise<CloseInfo> {
    if (this.closeInfo) return Promise.resolve(this.closeInfo)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.closeWaiters.findIndex(w => w.timer === timer)
        if (idx >= 0) this.closeWaiters.splice(idx, 1)
        reject(new Error('Timed out waiting for close'))
      }, timeoutMs)
      this.closeWaiters.push({ resolve, timer })
    })
  }

  send(message: Partial<WSMessage> & { type: string }): void {
    this.ws.send(JSON.stringify(message))
  }

  close(code?: number, reason?: string): void {
    this.ws.close(code, reason)
  }

  received(type: string): boolean {
    return this.messages.some(m => m.type === type)
  }

  /** 清掉未决的等待定时器，避免测试结束后产生悬空 rejection */
  dispose(): void {
    for (const w of this.msgWaiters.splice(0)) clearTimeout(w.timer)
    for (const w of this.closeWaiters.splice(0)) clearTimeout(w.timer)
  }

  private pump(): void {
    for (const waiter of [...this.msgWaiters]) {
      for (let i = this.cursor; i < this.messages.length; i++) {
        if (waiter.pred(this.messages[i])) {
          this.cursor = i + 1
          const idx = this.msgWaiters.indexOf(waiter)
          if (idx >= 0) this.msgWaiters.splice(idx, 1)
          clearTimeout(waiter.timer)
          waiter.resolve(this.messages[i])
          break
        }
      }
    }
  }
}

interface Harness {
  server: WSServer
  http: HTTPServer
  baseUrl: string
  clients: TestClient[]
  /** 房间门禁三件套：只在 createRoomHarness 里装配。 */
  rooms?: RoomService
  chat?: ChatService
  gateway?: RoomGateway
  tokenSecret?: string
}

const harnesses: Harness[] = []

async function createHarness(config: Partial<WSServerConfig> = {}): Promise<Harness> {
  const server = new WSServer(new Context())
  server.initialize({
    path: '/ws',
    tokenSecret: '',
    maxFileSize: 1024 * 1024,
    chunkSize: 1024,
    ...config
  })
  const http = createServer()
  http.on('upgrade', (req, socket, head) => server.handleUpgrade(req, socket, head))
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = http.address() as AddressInfo
  const harness: Harness = { server, http, baseUrl: `ws://127.0.0.1:${port}/ws`, clients: [] }
  harnesses.push(harness)
  return harness
}

/**
 * 装了真实 RoomService + RoomGateway 门禁的 harness，接线方式与 src/index.ts 的
 * apply() 一致：chat 先 initialize（sendMessage 依赖它的 config），再装门禁。
 */
async function createRoomHarness(): Promise<Harness> {
  const tokenSecret = 'room-test-secret'
  const h = await createHarness({ tokenSecret })
  const ctx = new Context()
  const rooms = new RoomService(ctx)
  const chat = new ChatService(ctx)
  chat.initialize()
  rooms.initialize()
  // 生产参数下 scrypt 每次约 30ms，测试调低成本跑得快；校验逻辑不受影响。
  rooms.setScryptParams({ N: 1024, r: 8, p: 1 })
  const gateway = new RoomGateway(ctx, rooms, chat, h.server)
  h.server.setRoomGate(gateway)
  h.rooms = rooms
  h.chat = chat
  h.gateway = gateway
  h.tokenSecret = tokenSecret
  return h
}

interface RoomClient {
  client: TestClient
  sessionId: string
  deviceId: string
}

/**
 * 连一个已登记凭据的客户端。真实流程里 REST 的 /devices/register 成功后
 * 会调 gateway.proveDevice()，这里直接调它等价地替身。
 */
async function connectRoomMember(h: Harness, deviceName: string): Promise<RoomClient> {
  const credential = h.rooms!.registerDevice({ deviceName })
  h.gateway!.proveDevice(credential.deviceId)
  const { client, sessionId } = await connectRegistered(h, {
    deviceId: credential.deviceId,
    deviceName,
    token: makeToken(credential.deviceId, h.tokenSecret!)
  })
  return { client, sessionId, deviceId: credential.deviceId }
}

/** 用 WS 建房，断言成功应答后返回它。 */
async function createRoomViaWs(owner: RoomClient, roomId: string, password: string): Promise<WSMessage> {
  owner.client.send({
    type: 'room-create',
    payload: { roomId, password, name: 'Demo' },
    messageId: `create-${roomId}`
  })
  const reply = await owner.client.waitFor(m => m.type === 'room-created' || m.type === 'error')
  expect(reply.type).toBe('room-created')
  return reply
}

/** 用 WS 进房，断言成功应答后返回它。 */
async function joinRoomViaWs(member: RoomClient, roomId: string, password: string): Promise<WSMessage> {
  member.client.send({ type: 'room-join', payload: { roomId, password } })
  const reply = await member.client.waitFor(m => m.type === 'room-joined' || m.type === 'error')
  expect(reply.type).toBe('room-joined')
  return reply
}

async function connectClient(h: Harness, params: Record<string, string> = {}): Promise<TestClient> {
  const client = await TestClient.open(h.baseUrl, params)
  h.clients.push(client)
  return client
}

/** 连接并消费 welcome，返回会话 id */
async function connectRegistered(
  h: Harness,
  params: Record<string, string> = {}
): Promise<{ client: TestClient; sessionId: string; welcome: WSMessage }> {
  const client = await connectClient(h, params)
  const welcome = await client.waitFor(m => m.type === 'welcome')
  return { client, sessionId: welcome.sessionId!, welcome }
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    h.server.shutdown()
    h.rooms?.shutdown()
    h.chat?.shutdown()
    for (const client of h.clients) {
      client.dispose()
      try {
        client.ws.terminate()
      } catch {
        /* ignore */
      }
    }
    const closeAll = (http: HTTPServer & { closeAllConnections?: () => void }) =>
      http.closeAllConnections?.()
    closeAll(h.http)
    await new Promise<void>(resolve => h.http.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// token 鉴权
// ---------------------------------------------------------------------------

describe('token 鉴权', () => {
  const SECRET = 'test-secret'

  it('携带正确 token 时建立连接、收到 welcome 并触发 connection 事件', async () => {
    const h = await createHarness({ tokenSecret: SECRET })
    const connections: WSSession[] = []
    h.server.on('connection', session => connections.push(session))

    const deviceId = 'dev-alpha'
    const { welcome } = await connectRegistered(h, {
      deviceId,
      token: makeToken(deviceId, SECRET)
    })

    expect(welcome.type).toBe('welcome')
    expect(welcome.sessionId).toBeTruthy()
    expect(welcome.payload).toMatchObject({
      sessionId: welcome.sessionId,
      deviceId,
      capabilities: ['file-transfer', 'chat', 'git-sync']
    })
    expect((welcome.payload as { deviceName: string }).deviceName.startsWith('Device-')).toBe(true)

    expect(connections).toHaveLength(1)
    expect(connections[0].sessionId).toBe(welcome.sessionId)
    expect(h.server.getSessions()).toHaveLength(1)
  })

  it('token 错误时以 4001 关闭连接，不建立任何会话', async () => {
    const h = await createHarness({ tokenSecret: SECRET })
    const connections: WSSession[] = []
    h.server.on('connection', session => connections.push(session))

    const client = await connectClient(h, { deviceId: 'dev-alpha', token: 'deadbeef' })
    const info = await client.waitForClose()

    expect(info).toEqual({ code: 4001, reason: 'Invalid token' })
    expect(connections).toHaveLength(0)
    expect(h.server.getSessions()).toHaveLength(0)
    expect(h.server.getDevices()).toHaveLength(0)
  })

  it('完全缺失 token 时同样以 4001 拒绝', async () => {
    const h = await createHarness({ tokenSecret: SECRET })
    const client = await connectClient(h, { deviceId: 'dev-alpha' })
    const info = await client.waitForClose()

    expect(info).toEqual({ code: 4001, reason: 'Invalid token' })
    expect(h.server.getSessions()).toHaveLength(0)
  })

  it('token 与 deviceId 绑定：为其它设备签发的 token 无法接入', async () => {
    const h = await createHarness({ tokenSecret: SECRET })
    // token 是给 dev-victim 签发的，却带着 dev-attacker 的 deviceId 连接
    const client = await connectClient(h, {
      deviceId: 'dev-attacker',
      token: makeToken('dev-victim', SECRET)
    })
    const info = await client.waitForClose()

    expect(info).toEqual({ code: 4001, reason: 'Invalid token' })
    expect(h.server.getSessions()).toHaveLength(0)
  })

  it('未配置 tokenSecret（空字符串）时不校验 token', async () => {
    const h = await createHarness({ tokenSecret: '' })
    const { welcome } = await connectRegistered(h, {
      deviceId: 'dev-free',
      token: 'not-even-a-token'
    })
    expect(welcome.type).toBe('welcome')
    expect(h.server.getSessions()).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// 会话建立与断开
// ---------------------------------------------------------------------------

describe('会话建立与断开', () => {
  it('connection 事件携带完整会话对象，getSession/getDeviceSessions 返回同一会话', async () => {
    const h = await createHarness()
    const fromEvent: WSSession[] = []
    h.server.on('connection', session => fromEvent.push(session))

    const { sessionId } = await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha' })

    expect(fromEvent).toHaveLength(1)
    const session = fromEvent[0]
    expect(session.sessionId).toBe(sessionId)
    expect(session.deviceId).toBe('dev-a')
    expect(session.deviceName).toBe('Alpha')
    expect(session.authenticated).toBe(true)
    expect(session.socket).toBeInstanceOf(WebSocket)
    expect(session.capabilities).toBeInstanceOf(Set)
    expect([...session.capabilities]).toEqual(['file-transfer', 'chat', 'git-sync'])
    expect(session.connectedAt).toBeGreaterThan(0)
    expect(session.lastActiveAt).toBeGreaterThanOrEqual(session.connectedAt)

    expect(h.server.getSession(sessionId)).toBe(session)
    expect(h.server.getDeviceSessions('dev-a')).toHaveLength(1)
    expect(h.server.getDeviceSessions('dev-a')[0]).toBe(session)
    expect(h.server.getDeviceSessions('no-such-device')).toEqual([])
    expect(h.server.getSession('no-such-session')).toBeUndefined()
  })

  it('deviceName 与 capabilities 查询参数生效并回传到 welcome', async () => {
    const h = await createHarness()
    const { welcome } = await connectRegistered(h, {
      deviceId: 'dev-a',
      deviceName: 'My Desktop',
      capabilities: 'file-transfer,remote-shell'
    })

    expect(welcome.payload).toMatchObject({
      deviceName: 'My Desktop',
      capabilities: ['file-transfer', 'remote-shell']
    })
    expect(h.server.getSessions()[0].deviceName).toBe('My Desktop')
    expect([...h.server.getSessions()[0].capabilities]).toEqual(['file-transfer', 'remote-shell'])
  })

  it('同设备的第二个会话向第一个会话广播 peer-connected，deviceConnected 只触发一次', async () => {
    const h = await createHarness()
    const deviceConnected = vi.fn()
    h.server.on('deviceConnected', deviceConnected)

    const first = await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha' })
    expect(deviceConnected).toHaveBeenCalledTimes(1)

    const second = await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha-2' })

    const peer = await first.client.waitFor(m => m.type === 'peer-connected')
    expect(peer.sessionId).toBe(second.sessionId)
    expect(peer.deviceId).toBe('dev-a')
    expect(peer.payload).toMatchObject({
      sessionId: second.sessionId,
      deviceId: 'dev-a',
      deviceName: 'Alpha-2'
    })

    // 新会话自身被排除在 peer-connected 之外，且不重复触发 deviceConnected
    await sleep(80)
    expect(second.client.received('peer-connected')).toBe(false)
    expect(deviceConnected).toHaveBeenCalledTimes(1)
    expect(h.server.getDeviceSessions('dev-a')).toHaveLength(2)
  })

  it('关闭同设备的一个会话：触发 disconnection/peer-disconnected，设备保留在注册表', async () => {
    const h = await createHarness()
    const deviceDisconnected = vi.fn()
    const disconnections: Array<{ sessionId: string; reason: string }> = []
    h.server.on('deviceDisconnected', deviceDisconnected)
    h.server.on('disconnection', (sessionId, reason) => disconnections.push({ sessionId, reason }))

    const first = await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha' })
    const second = await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha-2' })

    second.client.close(1000, 'bye')

    const peer = await first.client.waitFor(m => m.type === 'peer-disconnected')
    expect(peer.payload).toMatchObject({ sessionId: second.sessionId })

    await until(() => h.server.getSessions().length === 1, 4000, 'second session removal')
    expect(disconnections).toEqual([{ sessionId: second.sessionId, reason: 'bye' }])

    const devices = h.server.getDevices()
    expect(devices).toHaveLength(1)
    expect(devices[0]).toMatchObject({ deviceId: 'dev-a', sessionCount: 1 })
    // 设备还有会话，不应触发 deviceDisconnected
    expect(deviceDisconnected).not.toHaveBeenCalled()
    expect(first.client.received('device-disconnected')).toBe(false)
  })

  it('关闭设备最后一个会话：设备移出注册表并向其它设备广播 device-disconnected', async () => {
    const h = await createHarness()
    const deviceDisconnected = vi.fn()
    h.server.on('deviceDisconnected', deviceDisconnected)

    const a = await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha' })
    const b = await connectRegistered(h, { deviceId: 'dev-b', deviceName: 'Beta' })

    a.client.close(1000, 'gone')

    const notice = await b.client.waitFor(m => m.type === 'device-disconnected')
    expect(notice.deviceId).toBe('server')
    expect(notice.payload).toEqual({ deviceId: 'dev-a' })

    await until(() => deviceDisconnected.mock.calls.length === 1, 4000, 'deviceDisconnected')
    expect(deviceDisconnected).toHaveBeenCalledWith('dev-a')

    await until(() => h.server.getSessions().length === 1, 4000, 'session removal')
    expect(h.server.getDevices().map(d => d.deviceId)).toEqual(['dev-b'])
    expect(h.server.getDeviceSessions('dev-a')).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 设备注册表查询
// ---------------------------------------------------------------------------

describe('设备注册表查询 getDevices / getSessions', () => {
  it('getDevices 汇总每个设备的名称、时间戳、会话数与能力', async () => {
    const h = await createHarness()
    await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha', capabilities: 'file-transfer' })
    await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha' })
    await connectRegistered(h, { deviceId: 'dev-b', deviceName: 'Beta', capabilities: 'chat' })

    const devices = h.server.getDevices()
    expect(devices).toHaveLength(2)

    const devA = devices.find(d => d.deviceId === 'dev-a')!
    expect(devA.deviceName).toBe('Alpha')
    expect(devA.sessionCount).toBe(2)
    expect(devA.capabilities).toEqual(['file-transfer'])
    expect(devA.connectedAt).toBeGreaterThan(0)
    expect(devA.lastActiveAt).toBeGreaterThanOrEqual(devA.connectedAt)

    const devB = devices.find(d => d.deviceId === 'dev-b')!
    expect(devB.deviceName).toBe('Beta')
    expect(devB.sessionCount).toBe(1)
    expect(devB.capabilities).toEqual(['chat'])
  })

  it('getSessions 返回每个会话的摘要（含 authenticated 与 capabilities 数组）', async () => {
    const h = await createHarness()
    await connectRegistered(h, { deviceId: 'dev-a', deviceName: 'Alpha' })
    await connectRegistered(h, { deviceId: 'dev-b', deviceName: 'Beta', capabilities: 'chat' })

    const sessions = h.server.getSessions()
    expect(sessions).toHaveLength(2)

    const byDevice = new Map(sessions.map(s => [s.deviceId, s]))
    expect(byDevice.get('dev-a')).toMatchObject({
      deviceId: 'dev-a',
      deviceName: 'Alpha',
      authenticated: true,
      capabilities: ['file-transfer', 'chat', 'git-sync']
    })
    expect(byDevice.get('dev-b')).toMatchObject({
      deviceId: 'dev-b',
      deviceName: 'Beta',
      authenticated: true,
      capabilities: ['chat']
    })
    for (const s of sessions) {
      expect(s.sessionId).toMatch(/^[0-9a-f]{32}$/)
      expect(s.connectedAt).toBeGreaterThan(0)
      expect(s.lastActiveAt).toBeGreaterThanOrEqual(s.connectedAt)
    }
  })

  it('收到消息后会话的 lastActiveAt 被刷新', async () => {
    const h = await createHarness()
    const { client, sessionId } = await connectRegistered(h, { deviceId: 'dev-a' })

    const before = h.server.getSession(sessionId)!.lastActiveAt
    await sleep(5)
    client.send({ type: 'ping' })
    await client.waitFor(m => m.type === 'pong')

    expect(h.server.getSession(sessionId)!.lastActiveAt).toBeGreaterThan(before)
  })
})

// ---------------------------------------------------------------------------
// 消息路由
// ---------------------------------------------------------------------------

describe('消息路由', () => {
  it('带 targetDeviceId 的消息只投递给目标设备，发送者与其它设备都收不到', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })
    const c = await connectRegistered(h, { deviceId: 'dev-c' })

    a.client.send({ type: 'secret-note', targetDeviceId: 'dev-b', payload: { text: 'hi' } })

    const received = await b.client.waitFor(m => m.type === 'secret-note')
    expect(received.payload).toEqual({ text: 'hi' })
    expect(received.targetDeviceId).toBe('dev-b')

    await sleep(80)
    expect(a.client.received('secret-note')).toBe(false)
    expect(c.client.received('secret-note')).toBe(false)
  })

  it('不带 targetDeviceId 的消息广播给其它所有会话，排除发送者自身', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })
    const c = await connectRegistered(h, { deviceId: 'dev-c' })

    a.client.send({ type: 'gossip', payload: { n: 1 } })

    await b.client.waitFor(m => m.type === 'gossip')
    await c.client.waitFor(m => m.type === 'gossip')
    await sleep(80)
    expect(a.client.received('gossip')).toBe(false)
  })

  it('broadcastToAll / broadcastToDevice / sendToSession 的计数与排除逻辑', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const a2 = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })
    expect(h.server.getSessions()).toHaveLength(3)

    // 共 3 个会话，排除 a 自身 => 2
    expect(h.server.broadcastToAll({ type: 'probe-excluded', payload: null }, a.sessionId)).toBe(2)
    // dev-a 有 a 与 a2 两个会话，排除 a => 1
    expect(h.server.broadcastToDevice('dev-a', { type: 'probe-excluded', payload: null }, a.sessionId)).toBe(1)
    // 不排除 => 2（a 自己也会收到，所以用独立类型）
    expect(h.server.broadcastToDevice('dev-a', { type: 'probe-included', payload: null })).toBe(2)
    // 未知设备 => 0
    expect(h.server.broadcastToDevice('no-such-device', { type: 'probe-included', payload: null })).toBe(0)
    // 直发
    expect(h.server.sendToSession(a.sessionId, { type: 'direct-ping', payload: null })).toBe(true)
    expect(h.server.sendToSession('no-such-session', { type: 'direct-ping', payload: null })).toBe(false)

    // 计数对应的投递真实到达
    await a.client.waitFor(m => m.type === 'probe-included') // 未排除的广播确实到达 a
    await a.client.waitFor(m => m.type === 'direct-ping')
    await a2.client.waitFor(m => m.type === 'probe-excluded')
    await b.client.waitFor(m => m.type === 'probe-excluded')

    await sleep(80)
    // 被排除的两次广播都没有回到 a
    expect(a.client.received('probe-excluded')).toBe(false)
  })

  it('ping 触发 pong 应答（带 sessionId 与时间戳）并发出 message 事件', async () => {
    const h = await createHarness()
    const { client, sessionId } = await connectRegistered(h, { deviceId: 'dev-a' })
    const seen: WSMessage[] = []
    h.server.on('message', (_session, message) => seen.push(message))

    client.send({ type: 'ping', payload: null })
    const pong = await client.waitFor(m => m.type === 'pong')

    expect(pong.sessionId).toBe(sessionId)
    expect(typeof pong.payload).toBe('number')
    expect(pong.payload as number).toBeGreaterThan(0)

    await until(() => seen.some(m => m.type === 'ping'), 4000, 'message event for ping')
    expect(seen.find(m => m.type === 'ping')).toMatchObject({ type: 'ping', payload: null })
  })

  it('内置 handler：file-offer 带 targetDeviceId 时只转发给目标设备', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })
    const c = await connectRegistered(h, { deviceId: 'dev-c' })

    a.client.send({ type: 'file-offer', targetDeviceId: 'dev-b', payload: { fileId: 'f-1' } })

    const offer = await b.client.waitFor(m => m.type === 'file-offer')
    expect(offer.payload).toEqual({ fileId: 'f-1' })

    await sleep(80)
    expect(a.client.received('file-offer')).toBe(false)
    expect(c.client.received('file-offer')).toBe(false)
  })

  it('未安装房间门禁时 chat-message 被拒绝，任何会话都收不到（fail-closed）', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })
    const c = await connectRegistered(h, { deviceId: 'dev-c' })

    a.client.send({ type: 'chat-message', payload: { roomId: 'room-1', content: 'hello' }, messageId: 'm-1' })

    const error = await a.client.waitFor(m => m.type === 'error')
    expect(error.messageId).toBe('m-1')
    expect(error.payload).toEqual({ code: 'room-gate-unavailable', message: 'Room gate is not installed' })

    // 旧实现会把 chat-message 广播给发送者之外的所有会话；现在零投递、零状态变更。
    await sleep(80)
    expect(a.client.received('chat-message')).toBe(false)
    expect(b.client.received('chat-message')).toBe(false)
    expect(c.client.received('chat-message')).toBe(false)
  })

  it('自定义类型只要 payload 带 roomId 就按房间消息处理，未装门禁一律拒绝', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })

    a.client.send({ type: 'custom-thing', payload: { roomId: 'room-1' }, messageId: 'm-2' })

    const error = await a.client.waitFor(m => m.type === 'error')
    expect(error.messageId).toBe('m-2')
    expect(error.payload).toMatchObject({ code: 'room-gate-unavailable' })

    // 旧实现会把这种帧按普通消息广播给所有会话；现在被门禁端口拦下，零投递。
    await sleep(80)
    expect(b.client.received('custom-thing')).toBe(false)
  })

  it('无法解析的消息回复 Invalid message format，会话保持可用', async () => {
    const h = await createHarness()
    const { client, sessionId } = await connectRegistered(h, { deviceId: 'dev-a' })

    client.ws.send('this is not json {')
    const error = await client.waitFor(m => m.type === 'error')
    expect(error.payload).toBe('Invalid message format')

    client.send({ type: 'ping' })
    const pong = await client.waitFor(m => m.type === 'pong')
    expect(pong.sessionId).toBe(sessionId)
  })

  it('onMessage 注册的 handler 接管消息类型且不再广播', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })

    const handled: Array<{ deviceId: string; message: WSMessage }> = []
    h.server.onMessage('custom-thing', async (session, message) => {
      handled.push({ deviceId: session.deviceId, message })
    })

    a.client.send({ type: 'custom-thing', payload: { x: 1 } })
    await until(() => handled.length === 1, 4000, 'custom handler')

    expect(handled[0].deviceId).toBe('dev-a')
    expect(handled[0].message.type).toBe('custom-thing')
    expect(handled[0].message.payload).toEqual({ x: 1 })

    await sleep(80)
    expect(b.client.received('custom-thing')).toBe(false)
    expect(a.client.received('custom-thing')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 房间门禁（真实 RoomService + RoomGateway）
// ---------------------------------------------------------------------------

describe('房间门禁（真实 RoomService + RoomGateway）', () => {
  it('三个会话进同一房间后，chat-message 只投递给同房间成员，非成员收不到', async () => {
    const h = await createRoomHarness()
    const owner = await connectRoomMember(h, 'Owner')
    const member = await connectRoomMember(h, 'Member')
    const member2 = await connectRoomMember(h, 'Member-2')
    const outsider = await connectRoomMember(h, 'Outsider')

    await createRoomViaWs(owner, '123456', 'secret-1')
    await joinRoomViaWs(member, '123456', 'secret-1')
    await joinRoomViaWs(member2, '123456', 'secret-1')

    owner.client.send({
      type: 'chat-message',
      payload: { roomId: '123456', content: 'hello room' },
      messageId: 'chat-1'
    })

    // 发送者只拿落库后的 ack，不拿广播
    const ack = await owner.client.waitFor(m => m.type === 'chat-message-ack')
    expect(ack.messageId).toBe('chat-1')
    expect(ack.payload).toMatchObject({ roomId: '123456', content: 'hello room', senderDeviceId: owner.deviceId })

    const toMember = await member.client.waitFor(m => m.type === 'chat-message')
    expect(toMember.payload).toMatchObject({ roomId: '123456', content: 'hello room' })
    await member2.client.waitFor(m => m.type === 'chat-message')

    await sleep(80)
    expect(owner.client.received('chat-message')).toBe(false)
    expect(outsider.client.received('chat-message')).toBe(false)
    expect(outsider.client.received('chat-message-ack')).toBe(false)

    // 消息确实落到了 ChatService 的这个房间
    expect(h.chat!.getHistory('123456')).toHaveLength(1)
  })

  it('非成员发 chat-message 被拒（not-a-member），消息不落库也不广播', async () => {
    const h = await createRoomHarness()
    const owner = await connectRoomMember(h, 'Owner')
    const outsider = await connectRoomMember(h, 'Outsider')

    await createRoomViaWs(owner, '123456', 'secret-1')

    outsider.client.send({
      type: 'chat-message',
      payload: { roomId: '123456', content: 'let me in' },
      messageId: 'chat-9'
    })

    const error = await outsider.client.waitFor(m => m.type === 'error')
    expect(error.messageId).toBe('chat-9')
    expect(error.payload).toMatchObject({ code: 'not-a-member' })

    await sleep(80)
    expect(owner.client.received('chat-message')).toBe(false)
    expect(h.chat!.getHistory('123456')).toHaveLength(0)
  })

  it('非成员收不到房间广播，新加入者自己也不会收到 user-joined', async () => {
    const h = await createRoomHarness()
    const owner = await connectRoomMember(h, 'Owner')
    const member = await connectRoomMember(h, 'Member')
    const outsider = await connectRoomMember(h, 'Outsider')

    await createRoomViaWs(owner, '123456', 'secret-1')

    member.client.send({ type: 'room-join', payload: { roomId: '123456', password: 'secret-1' } })
    const joined = await member.client.waitFor(m => m.type === 'room-joined' || m.type === 'error')
    expect(joined.type).toBe('room-joined')

    const notice = await owner.client.waitFor(m => m.type === 'user-joined')
    expect(notice.payload).toMatchObject({
      roomId: '123456',
      deviceId: member.deviceId,
      deviceName: 'Member',
      role: 'member'
    })

    await sleep(80)
    // user-joined 的收件快照排除新加入者自己的会话；非成员根本不在快照里。
    expect(member.client.received('user-joined')).toBe(false)
    expect(outsider.client.received('user-joined')).toBe(false)
  })

  it('建房/进房回显请求的 messageId，错误帧带 code 与 message 的 payload', async () => {
    const h = await createRoomHarness()
    const observed: WSMessage[] = []
    h.server.on('message', (_session, message) => observed.push(message))

    const owner = await connectRoomMember(h, 'Owner')
    const member = await connectRoomMember(h, 'Member')
    const outsider = await connectRoomMember(h, 'Outsider')

    owner.client.send({
      type: 'room-create',
      payload: { roomId: '123456', password: 'secret-1' },
      messageId: 'req-create'
    })
    const created = await owner.client.waitFor(m => m.type === 'room-created')
    expect(created.messageId).toBe('req-create')
    expect(created.payload).toMatchObject({
      room: { roomId: '123456' },
      member: { role: 'owner' },
      ticket: { roomId: '123456', role: 'owner' }
    })

    member.client.send({
      type: 'room-join',
      payload: { roomId: '123456', password: 'secret-1' },
      messageId: 'req-join'
    })
    const joined = await member.client.waitFor(m => m.type === 'room-joined')
    expect(joined.messageId).toBe('req-join')

    // 错误帧同样回显 messageId，payload 是 { code, message } 形状
    outsider.client.send({
      type: 'room-join',
      payload: { roomId: '123456', password: 'wrong-pass' },
      messageId: 'req-join-2'
    })
    const error = await outsider.client.waitFor(m => m.type === 'error')
    expect(error.messageId).toBe('req-join-2')
    const payload = error.payload as { code: string; message: string }
    expect(payload.code).toBe('wrong-password')
    expect(typeof payload.message).toBe('string')

    // 观测事件拿到的是抹掉密码后的副本（room-create/room-join/room-password）
    const seenCreate = observed.find(m => m.type === 'room-create')
    expect(seenCreate?.payload).toMatchObject({ roomId: '123456', password: '***' })
  })

  it('会话断开后该会话被移出房间，席位保留，其它成员收到 user-left', async () => {
    const h = await createRoomHarness()
    const owner = await connectRoomMember(h, 'Owner')
    const member = await connectRoomMember(h, 'Member')

    await createRoomViaWs(owner, '123456', 'secret-1')
    await joinRoomViaWs(member, '123456', 'secret-1')

    expect(h.rooms!.isSessionMember('123456', member.deviceId, member.sessionId)).toBe(true)

    member.client.close(1000, 'bye')

    await until(
      () => !h.rooms!.isSessionMember('123456', member.deviceId, member.sessionId),
      4000,
      'session removal from room'
    )

    // 断线只摘会话：设备席位保留，房主会话不受影响
    expect(h.rooms!.isMember('123456', member.deviceId)).toBe(true)
    expect(h.rooms!.isSessionMember('123456', owner.deviceId, owner.sessionId)).toBe(true)

    const left = await owner.client.waitFor(m => m.type === 'user-left')
    expect(left.payload).toEqual({ roomId: '123456', deviceId: member.deviceId, reason: 'disconnected' })

    // 重连后走成员快速通道：不用正确密码也能回到房间
    const reconnected = await connectRegistered(h, {
      deviceId: member.deviceId,
      token: makeToken(member.deviceId, h.tokenSecret!)
    })
    reconnected.client.send({ type: 'room-join', payload: { roomId: '123456', password: 'whatever' } })
    const rejoined = await reconnected.client.waitFor(m => m.type === 'room-joined' || m.type === 'error')
    expect(rejoined.type).toBe('room-joined')
    expect(h.rooms!.isSessionMember('123456', member.deviceId, reconnected.sessionId)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// request-response
// ---------------------------------------------------------------------------

describe('request-response', () => {
  it('对端按 messageId 回复后 promise 以 payload resolve', async () => {
    const h = await createHarness()
    const { client, sessionId } = await connectRegistered(h, { deviceId: 'dev-a' })

    const pending = h.server.request(sessionId, { type: 'calc', payload: { a: 1, b: 2 } }, 4000)

    const request = await client.waitFor(m => m.type === 'calc')
    expect(request.messageId).toMatch(/^[0-9a-f]{32}$/)
    expect(request.payload).toEqual({ a: 1, b: 2 })

    client.send({ type: 'calc-result', messageId: request.messageId, payload: { sum: 3 } })
    await expect(pending).resolves.toEqual({ sum: 3 })
  })

  it('对端以 type=error 回复时 promise 拒绝并携带错误文本', async () => {
    const h = await createHarness()
    const { client, sessionId } = await connectRegistered(h, { deviceId: 'dev-a' })

    const pending = h.server.request(sessionId, { type: 'calc', payload: null }, 4000)
    const request = await client.waitFor(m => m.type === 'calc')

    client.send({ type: 'error', messageId: request.messageId, payload: 'device refused' })
    await expect(pending).rejects.toThrow('device refused')
  })

  it('对端不回复时在 timeoutMs 后以 Request timeout 拒绝', async () => {
    const h = await createHarness()
    const { client, sessionId } = await connectRegistered(h, { deviceId: 'dev-a' })

    const pending = h.server.request(sessionId, { type: 'slow-op', payload: null }, 150)
    await expect(pending).rejects.toThrow('Request timeout')

    // 请求本身确实送达了对端
    const request = await client.waitFor(m => m.type === 'slow-op')
    expect(request.messageId).toBeTruthy()
  })

  it('对不存在的会话发起 request 同样以超时拒绝', async () => {
    const h = await createHarness()
    await expect(
      h.server.request('no-such-session', { type: 'ping', payload: null }, 150)
    ).rejects.toThrow('Request timeout')
  })

  it('超时之后的迟到回复不再命中 pending，而是走普通广播路径', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })

    const pending = h.server.request(a.sessionId, { type: 'slow-op', payload: null }, 150)
    const request = await a.client.waitFor(m => m.type === 'slow-op')
    await expect(pending).rejects.toThrow('Request timeout')

    // 迟到回复：messageId 已从 pendingRequests 移除，按普通消息广播
    a.client.send({ type: 'slow-op-result', messageId: request.messageId, payload: 'late' })
    const relayed = await b.client.waitFor(m => m.type === 'slow-op-result')
    expect(relayed.payload).toBe('late')
    await sleep(80)
    expect(a.client.received('slow-op-result')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// handleUpgrade 未初始化 / shutdown
// ---------------------------------------------------------------------------

describe('生命周期', () => {
  it('未 initialize 时到达的 upgrade 不会被完成握手，客户端连接失败', async () => {
    const server = new WSServer(new Context()) // 故意不调用 initialize()
    const http = createServer()
    let upgradeSocket: import('net').Socket | undefined
    http.on('upgrade', (req, socket, head) => {
      upgradeSocket = socket
      server.handleUpgrade(req, socket, head)
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const { port } = http.address() as AddressInfo

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { handshakeTimeout: 1500 })
      let opened = false
      client.on('open', () => {
        opened = true
      })
      const error = await new Promise<Error>(resolve => client.once('error', resolve))
      expect(error).toBeInstanceOf(Error)
      expect(opened).toBe(false)
      try {
        client.terminate()
      } catch {
        /* ignore */
      }
    } finally {
      // handleUpgrade 静默返回时不会销毁升级 socket（见 suspectedBugs），
      // 必须由测试自己销毁，否则 http.close() 会一直等待该连接。
      upgradeSocket?.destroy()
      const closeAll = (srv: HTTPServer & { closeAllConnections?: () => void }) =>
        srv.closeAllConnections?.()
      closeAll(http)
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  })

  it('shutdown 以 1001 关闭所有客户端并清空注册表', async () => {
    const h = await createHarness()
    const a = await connectRegistered(h, { deviceId: 'dev-a' })
    const b = await connectRegistered(h, { deviceId: 'dev-b' })
    expect(h.server.getSessions()).toHaveLength(2)

    h.server.shutdown()

    const infoA = await a.client.waitForClose()
    const infoB = await b.client.waitForClose()
    expect(infoA).toEqual({ code: 1001, reason: 'Server shutting down' })
    expect(infoB).toEqual({ code: 1001, reason: 'Server shutting down' })

    expect(h.server.getSessions()).toEqual([])
    expect(h.server.getDevices()).toEqual([])
  })
})
