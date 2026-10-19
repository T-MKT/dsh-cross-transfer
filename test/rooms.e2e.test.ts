/**
 * 房间机制端到端验收测试。
 *
 * 与 test/ws-server.test.ts 直接 new WSServer 的集成不同，这里走真实宿主接线：
 * - 用 ctx.provide('webServer', fake) 造出插件依赖的路由载体，然后调用
 *   src/index.ts 的 apply()，让插件自己完成 WS 升级路由与 REST 前缀路由的注册；
 * - 再起一个真实 http server，把请求与 upgrade 转交给 apply 登记的 handler，
 *   转接方式与宿主加载本插件时一致；
 * - 设备身份走真实 REST /devices/register 流程，WS 用返回的 token 接入；
 * - 断言只看线上行为（WS 帧 + HTTP 状态码），不回查服务内部状态。
 *
 * 跑法：node node_modules/vitest/vitest.mjs run test/rooms.e2e.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { Duplex } from 'stream'
import { createHash } from 'crypto'
import { WebSocket } from 'ws'
import { apply } from '../src/index.js'
import { DEFAULT_ROOM_CONFIG, maskDeviceId, type RoomConfig, type RoomJoinResult } from '../src/rooms.js'
import type { WSMessage } from '../src/ws-server.js'
import type { ChatMessage } from '../src/chat.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 插件挂载路径与 tokenSecret：apply 的配置与 token 计算共用这两个常量。 */
const MOUNT_PATH = '/api/cross-transfer'
const TOKEN_SECRET = 'e2e-token-secret'
const PASSWORD = 'e2e-pass-123'
const WRONG_PASSWORD = 'not-the-pass'

interface RestRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

interface E2EHarness {
  ctx: Context
  http: HTTPServer
  httpBaseUrl: string
  wsBaseUrl: string
  clients: TestClient[]
  restRoutes: RestRoute[]
  upgradeRoutes: UpgradeRoute[]
  /** register / registerUpgrade 交还的 disposer，apply 把它们托管进 ctx.effect。 */
  disposers: Array<() => void>
}

const harnesses: E2EHarness[] = []

/**
 * 夹具配方：宿主半加载的前提是一个 webServer 服务。fake 只记录路由登记，
 * 真正的请求由测试自己起的 http server 转交 —— 这样 apply() 的全部宿主
 * 接线（路由注册、effect 托管、服务构造顺序）都原样跑到。
 */
async function createE2eHarness(rooms: Partial<RoomConfig> = {}): Promise<E2EHarness> {
  const ctx = new Context()
  const restRoutes: RestRoute[] = []
  const upgradeRoutes: UpgradeRoute[] = []
  const disposers: Array<() => void> = []

  const fakeWebServer = {
    register(entry: RestRoute) {
      restRoutes.push(entry)
      const dispose = () => {
        const idx = restRoutes.indexOf(entry)
        if (idx >= 0) restRoutes.splice(idx, 1)
      }
      disposers.push(dispose)
      return dispose
    },
    registerUpgrade(entry: UpgradeRoute) {
      upgradeRoutes.push(entry)
      const dispose = () => {
        const idx = upgradeRoutes.indexOf(entry)
        if (idx >= 0) upgradeRoutes.splice(idx, 1)
      }
      disposers.push(dispose)
      return dispose
    }
  }
  ctx.provide('webServer', fakeWebServer)

  apply(ctx, {
    path: MOUNT_PATH,
    tokenSecret: TOKEN_SECRET,
    maxFileSize: 1048576,
    chunkSize: 1024,
    rooms: { ...DEFAULT_ROOM_CONFIG, ...rooms }
  })

  const http = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    for (const route of restRoutes) {
      if (route.kind === 'prefix' && (pathname === route.path || pathname.startsWith(`${route.path}/`))) {
        void route.handler(req, res)
        return
      }
    }
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Not found' }))
  })
  http.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
    for (const route of upgradeRoutes) {
      if (route.path === pathname) {
        route.handler(req, socket, head)
        return
      }
    }
    socket.destroy()
  })
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject)
    http.listen(0, '127.0.0.1', () => resolve())
  })
  const { port } = http.address() as AddressInfo

  const harness: E2EHarness = {
    ctx,
    http,
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    clients: [],
    restRoutes,
    upgradeRoutes,
    disposers
  }
  harnesses.push(harness)
  return harness
}

type MsgWaiter = {
  pred: (m: WSMessage) => boolean
  resolve: (m: WSMessage) => void
  timer: ReturnType<typeof setTimeout>
}

/** 照 test/ws-server.test.ts 的 TestClient 抄：轮询式等待，不用固定长 sleep。 */
class TestClient {
  readonly ws: WebSocket
  readonly messages: WSMessage[] = []
  private cursor = 0
  private msgWaiters: MsgWaiter[] = []

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

/** 全量扫描等待某类帧（不推进游标），用于顺序不确定的广播断言。轮询式。 */
async function waitForAny(client: TestClient, pred: (m: WSMessage) => boolean, timeoutMs = 4000): Promise<WSMessage> {
  const start = Date.now()
  for (;;) {
    const found = client.messages.find(pred)
    if (found) return found
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for message; received=${JSON.stringify(client.messages)}`)
    }
    await sleep(20)
  }
}

/**
 * 负向断言的静默窗口：给「不该发生的投递」留出到达的机会，再确认没出现。
 * 这不是等待某个条件成立，而是排除迟到的帧。
 */
async function expectSilence(client: TestClient, pred: (m: WSMessage) => boolean, windowMs = 200): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < windowMs) {
    const found = client.messages.find(pred)
    if (found) throw new Error(`unexpected frame received: ${JSON.stringify(found)}`)
    await sleep(20)
  }
}

interface HttpResult {
  status: number
  body: any
}

async function httpJson(
  h: E2EHarness,
  method: 'GET' | 'POST' | 'DELETE',
  route: string,
  options: { body?: unknown; authorization?: string } = {}
): Promise<HttpResult> {
  const res = await fetch(`${h.httpBaseUrl}${MOUNT_PATH}${route}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.authorization ? { Authorization: options.authorization } : {})
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  })
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, body }
}

interface Member {
  client: TestClient
  sessionId: string
  deviceId: string
  deviceSecret: string
  deviceName: string
}

/** 真实流程：REST /devices/register 登记凭据，再用返回的 token 建 WS 连接。 */
async function connectDevice(h: E2EHarness, deviceName: string): Promise<Member> {
  const registered = await httpJson(h, 'POST', '/devices/register', { body: { deviceName } })
  expect(registered.status).toBe(200)
  expect(typeof registered.body.deviceId).toBe('string')
  expect(typeof registered.body.deviceSecret).toBe('string')
  expect(registered.body.token).toBeTruthy()

  const client = await TestClient.open(`${h.wsBaseUrl}${MOUNT_PATH}`, {
    deviceId: registered.body.deviceId,
    token: registered.body.token,
    deviceName
  })
  h.clients.push(client)
  const welcome = await client.waitFor(m => m.type === 'welcome')
  return {
    client,
    sessionId: welcome.sessionId!,
    deviceId: registered.body.deviceId,
    deviceSecret: registered.body.deviceSecret,
    deviceName
  }
}

/** 与 ws-server.validateToken 相同的 token 计算，用于同设备重连。 */
function makeDeviceToken(deviceId: string): string {
  return createHash('sha256').update(`${deviceId}:${TOKEN_SECRET}`).digest('hex')
}

let rpcSeq = 0

/** 发送带 messageId 的请求帧，等待同 messageId 的应答（成功帧或 error 帧）。 */
async function rpc(client: TestClient, type: string, payload: unknown, messageId: string): Promise<WSMessage> {
  client.send({ type, payload, messageId })
  return client.waitFor(m => m.messageId === messageId, 8000)
}

async function createRoomViaWs(owner: Member, roomId: string | undefined, password: string): Promise<RoomJoinResult> {
  const payload: Record<string, unknown> = { password, name: '验收房' }
  if (roomId !== undefined) payload.roomId = roomId
  const reply = await rpc(owner.client, 'room-create', payload, `create-${roomId ?? 'random'}-${++rpcSeq}`)
  expect(reply.type).toBe('room-created')
  return reply.payload as RoomJoinResult
}

async function joinRoomViaWs(member: Member, roomId: string, password: string): Promise<RoomJoinResult> {
  const reply = await rpc(member.client, 'room-join', { roomId, password }, `join-${roomId}-${++rpcSeq}`)
  expect(reply.type).toBe('room-joined')
  return reply.payload as RoomJoinResult
}

afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    for (const client of h.clients) {
      client.dispose()
      try {
        client.ws.terminate()
      } catch {
        /* ignore */
      }
    }
    const closeAll = (srv: HTTPServer & { closeAllConnections?: () => void }) => srv.closeAllConnections?.()
    closeAll(h.http)
    await new Promise<void>(resolve => h.http.close(() => resolve()))
  }
})

// ---------------------------------------------------------------------------
// 宿主接线
// ---------------------------------------------------------------------------

describe('房间机制端到端验收（真实 apply 接线）', () => {
  describe('宿主接线', () => {
    it('apply 向 webServer 注册一个 prefix 路由与一个 upgrade 路由，并各拿到一个 disposer', async () => {
      const h = await createE2eHarness()
      expect(h.restRoutes).toHaveLength(1)
      expect(h.restRoutes[0].kind).toBe('prefix')
      expect(h.restRoutes[0].path).toBe(MOUNT_PATH)
      expect(h.upgradeRoutes).toHaveLength(1)
      expect(h.upgradeRoutes[0].path).toBe(MOUNT_PATH)
      expect(h.disposers).toHaveLength(2)
      for (const dispose of h.disposers) {
        expect(typeof dispose).toBe('function')
      }
    })
  })

  // -------------------------------------------------------------------------
  // WS 面
  // -------------------------------------------------------------------------

  describe('WS 面', () => {
    it('验收1 房主建房成功：拿到合法房号与票据，返回体不含密码/哈希/salt', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')

      const created = await createRoomViaWs(owner, '236812', PASSWORD)
      expect(created.room.roomId).toBe('236812')
      expect(created.room.roomId).toMatch(/^[0-9]{4,12}$/)
      expect(created.room.name).toBe('验收房')
      expect(created.member.role).toBe('owner')
      expect(created.member.online).toBe(true)
      expect(created.ticket.roomId).toBe('236812')
      expect(created.ticket.role).toBe('owner')
      expect(created.ticket.ticket).toMatch(/^[0-9a-f]{64}$/)
      expect(created.ticket.expiresAt).toBeGreaterThan(created.ticket.issuedAt)

      // 对外投影不得携带任何秘密材料：明文密码、哈希算法痕迹、salt、哈希字段。
      const serialized = JSON.stringify(created)
      expect(serialized).not.toContain(PASSWORD)
      expect(serialized).not.toContain('scrypt')
      expect(serialized).not.toContain('salt')
      expect(serialized).not.toContain('passwordHash')

      // 省略房号时服务端分配的随机房号同样是合法格式
      const random = await createRoomViaWs(owner, undefined, PASSWORD)
      expect(random.room.roomId).toMatch(/^[0-9]{4,12}$/)
      expect(random.room.roomId).not.toBe('236812')
    })

    it('验收2 密码错误进不去：拒绝帧带 code，此后他的 chat-message 仍被拒、房间广播一条收不到', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const intruder = await connectDevice(h, 'Intruder')
      await createRoomViaWs(owner, '311001', PASSWORD)

      const bad = await rpc(intruder.client, 'room-join', { roomId: '311001', password: WRONG_PASSWORD }, 'join-bad')
      expect(bad.type).toBe('error')
      expect(bad.messageId).toBe('join-bad')
      const badPayload = bad.payload as { code: string; message: string }
      expect(badPayload.code).toBe('wrong-password')
      expect(typeof badPayload.message).toBe('string')

      // 没成为成员：发 chat-message 仍被拒
      const chatErr = await rpc(intruder.client, 'chat-message', { roomId: '311001', content: '放我进去' }, 'chat-bad')
      expect(chatErr.type).toBe('error')
      expect((chatErr.payload as { code: string }).code).toBe('not-a-member')

      // 房间广播一条收不到：房主在房内发言，只有他自己的 ack，闯入者什么都拿不到
      owner.client.send({ type: 'chat-message', payload: { roomId: '311001', content: '内部消息' }, messageId: 'chat-owner' })
      await owner.client.waitFor(m => m.type === 'chat-message-ack')
      await expectSilence(intruder.client, m => m.type === 'chat-message' || m.type === 'chat-message-ack' || m.type === 'user-joined')
    })

    it('验收3 房间号不存在时进不去：错误码是 room-not-found', async () => {
      const h = await createE2eHarness()
      const stranger = await connectDevice(h, 'Stranger')

      const reply = await rpc(stranger.client, 'room-join', { roomId: '999999', password: PASSWORD }, 'join-miss')
      expect(reply.type).toBe('error')
      expect(reply.messageId).toBe('join-miss')
      expect((reply.payload as { code: string }).code).toBe('room-not-found')
    })

    it('验收4 房号密码都对能进去：chat-message 到达同房间成员，非成员收不到', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      const outsider = await connectDevice(h, 'Outsider')

      await createRoomViaWs(owner, '311002', PASSWORD)
      const joined = await joinRoomViaWs(member, '311002', PASSWORD)
      expect(joined.member.role).toBe('member')
      expect(joined.ticket.ticket).toMatch(/^[0-9a-f]{64}$/)

      // 房主收到新成员通知，deviceId 是真实 id（推送语义），新加入者自己不收
      const notice = await waitForAny(owner.client, m => m.type === 'user-joined')
      expect(notice.payload).toMatchObject({ roomId: '311002', deviceId: member.deviceId, role: 'member' })
      expect(member.client.received('user-joined')).toBe(false)

      member.client.send({ type: 'chat-message', payload: { roomId: '311002', content: '大家好' }, messageId: 'chat-ok' })
      const ack = await member.client.waitFor(m => m.type === 'chat-message-ack')
      expect(ack.messageId).toBe('chat-ok')
      expect((ack.payload as ChatMessage).content).toBe('大家好')

      const broadcast = await waitForAny(owner.client, m => m.type === 'chat-message')
      expect(broadcast.payload).toMatchObject({ roomId: '311002', content: '大家好' })

      // 非成员收不到；发送者只拿 ack、不拿自己的广播
      await expectSilence(outsider.client, m => m.type === 'chat-message' || m.type === 'chat-message-ack')
      expect(member.client.messages.filter(m => m.type === 'chat-message')).toHaveLength(0)
    })

    it('验收6 房主关房后：新的人进不去（room-closed），成员收到关房通知', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      const newcomer = await connectDevice(h, 'Newcomer')

      await createRoomViaWs(owner, '311004', PASSWORD)
      await joinRoomViaWs(member, '311004', PASSWORD)

      const closed = await rpc(owner.client, 'room-close', { roomId: '311004' }, 'close-1')
      expect(closed.type).toBe('room-closed')
      expect(closed.payload).toEqual({ roomId: '311004', reason: 'closed-by-owner' })

      // 成员收到关房广播（无 messageId 的推送帧）
      const notice = await waitForAny(member.client, m => m.type === 'room-closed' && m.messageId === undefined)
      expect(notice.payload).toEqual({ roomId: '311004', reason: 'closed-by-owner' })

      // 新的人进不去：房间已删，命中墓碑
      const late = await rpc(newcomer.client, 'room-join', { roomId: '311004', password: PASSWORD }, 'join-late')
      expect(late.type).toBe('error')
      expect((late.payload as { code: string }).code).toBe('room-closed')
    })

    it('验收7 会话断开后：该会话被移出房间（user-left 推送、成员行会话数清零），席位按契约保留为离线', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')

      await createRoomViaWs(owner, '311005', PASSWORD)
      await joinRoomViaWs(member, '311005', PASSWORD)

      member.client.close(1000, 'bye')

      // 房主收到 user-left：会话级成员资格被清理的对外信号
      const left = await waitForAny(owner.client, m => m.type === 'user-left')
      expect(left.payload).toEqual({ roomId: '311005', deviceId: member.deviceId, reason: 'disconnected' })

      // 成员列表：他的会话已从成员行摘掉（sessionCount=0、online=false）；
      // 席位按冻结契约保留（成员行还在），断言的是会话被清理而非行被删除。
      // 成员视图一律脱敏（契约 §1.1），按脱敏 id 定位他的行。
      const listed = await rpc(owner.client, 'room-members', { roomId: '311005' }, 'members-1')
      expect(listed.type).toBe('room-members')
      const members = (listed.payload as { roomId: string; members: Array<{ deviceId: string; online: boolean; sessionCount: number }> }).members
      const row = members.find(m => m.deviceId === maskDeviceId(member.deviceId))
      expect(row).toBeTruthy()
      expect(row!.online).toBe(false)
      expect(row!.sessionCount).toBe(0)

      // 席位保留的对外证据：同设备重连即使密码不对也走成员快速通道回房
      const reconnected = await TestClient.open(`${h.wsBaseUrl}${MOUNT_PATH}`, {
        deviceId: member.deviceId,
        token: makeDeviceToken(member.deviceId),
        deviceName: member.deviceName
      })
      h.clients.push(reconnected)
      await reconnected.waitFor(m => m.type === 'welcome')
      const rejoined = await rpc(reconnected, 'room-join', { roomId: '311005', password: WRONG_PASSWORD }, 'rejoin-fast')
      expect(rejoined.type).toBe('room-joined')
    })
  })

  // -------------------------------------------------------------------------
  // REST 面
  // -------------------------------------------------------------------------

  describe('REST 面', () => {
    it('验收5 REST 与 WS 一致：create/join 错的进不去对的进得去，members 不带票据被拒', async () => {
      const h = await createE2eHarness()

      const ownerReg = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Rest-Owner' } })
      expect(ownerReg.status).toBe(200)
      const ownerSecret: string = ownerReg.body.deviceSecret

      const created = await httpJson(h, 'POST', '/rooms/create', {
        authorization: `Bearer ${ownerSecret}`,
        body: { roomId: '311003', password: PASSWORD, name: 'REST 房' }
      })
      expect(created.status).toBe(200)
      expect(created.body.room.roomId).toBe('311003')
      expect(created.body.member.role).toBe('owner')
      expect(created.body.ticket.role).toBe('owner')
      const createdText = JSON.stringify(created.body)
      expect(createdText).not.toContain(PASSWORD)
      expect(createdText).not.toContain('scrypt')

      // 错密码：401，错误体是 { error: { code, message } }
      const joinerReg = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Rest-Joiner' } })
      expect(joinerReg.status).toBe(200)
      const joinerSecret: string = joinerReg.body.deviceSecret

      const bad = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '311003', password: WRONG_PASSWORD, deviceSecret: joinerSecret }
      })
      expect(bad.status).toBe(401)
      expect(bad.body.error.code).toBe('wrong-password')

      // 对密码：200，成员行与票据齐全
      const good = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '311003', password: PASSWORD, deviceSecret: joinerSecret }
      })
      expect(good.status).toBe(200)
      expect(good.body.member.role).toBe('member')
      const ticket: string = good.body.ticket.ticket
      expect(ticket).toMatch(/^[0-9a-f]{64}$/)

      // members 不带票据：401 invalid-ticket，绝不返回成员数据
      const naked = await httpJson(h, 'GET', '/rooms/311003/members')
      expect(naked.status).toBe(401)
      expect(naked.body.error.code).toBe('invalid-ticket')
      expect(naked.body.members).toBeUndefined()

      // 带票据：200，两个成员（房主 + 加入者）
      const listed = await httpJson(h, 'GET', '/rooms/311003/members', { authorization: `Bearer ${ticket}` })
      expect(listed.status).toBe(200)
      expect(listed.body.roomId).toBe('311003')
      expect(listed.body.members).toHaveLength(2)
    })

    it('验收8 /chat/history 不带票据拿不到房间历史（不再明文开放）', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      await createRoomViaWs(owner, '311006', PASSWORD)
      await joinRoomViaWs(member, '311006', PASSWORD)

      member.client.send({ type: 'chat-message', payload: { roomId: '311006', content: '机密历史' }, messageId: 'seed-1' })
      await member.client.waitFor(m => m.type === 'chat-message-ack')

      const naked = await httpJson(h, 'GET', '/chat/history?roomId=311006')
      expect(naked.status).toBe(401)
      expect(naked.body.error.code).toBe('invalid-ticket')
      expect(JSON.stringify(naked.body)).not.toContain('机密历史')
    })

    it('验收9 聊天真落库：成员发消息后，带票据的历史接口读回同一条内容', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      await createRoomViaWs(owner, '311007', PASSWORD)
      const joined = await joinRoomViaWs(member, '311007', PASSWORD)
      const ticket: string = joined.ticket.ticket

      member.client.send({
        type: 'chat-message',
        payload: { roomId: '311007', content: '落库验收消息', type: 'text' },
        messageId: 'persist-1'
      })
      const ack = await member.client.waitFor(m => m.type === 'chat-message-ack')
      const acked = ack.payload as ChatMessage
      expect(acked.messageId).toBeTruthy()
      expect(acked.content).toBe('落库验收消息')

      const history = await httpJson(h, 'GET', '/chat/history?roomId=311007&limit=10', {
        authorization: `Bearer ${ticket}`
      })
      expect(history.status).toBe(200)
      expect(history.body.roomId).toBe('311007')
      const messages = history.body.messages as Array<Pick<ChatMessage, 'messageId' | 'content' | 'roomId'>>
      // 读回的必须就是 ack 里那条：证明 chat-message 真的写进了 ChatService
      expect(messages.some(m => m.messageId === acked.messageId && m.content === '落库验收消息')).toBe(true)
    })
  })
})
