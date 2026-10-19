/**
 * 房间容量与生命周期边界攻击测试。
 *
 * 接线与 test/rooms.e2e.test.ts 相同：ctx.provide('webServer', fake) 造出宿主
 * 依赖的路由载体，调用 src/index.ts 的 apply() 让插件自己完成 WS 升级路由与
 * REST 前缀路由注册，再起一个真实 http server 转交请求/upgrade，WS 用真实
 * ws 客户端。每条用例断言一个「系统应当具备的性质」（冻结契约 v3），
 * 用例红 = 找到一个洞，不为绿放宽断言。
 *
 * 跑法：node node_modules/vitest/vitest.mjs run test/rooms-limits.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { Duplex } from 'stream'
import { createHash } from 'crypto'
import { WebSocket } from 'ws'
import { apply } from '../src/index.js'
import { DEFAULT_ROOM_CONFIG, maskDeviceId, type RoomConfig, type RoomJoinResult, type RoomLeaveResult } from '../src/rooms.js'
import type { WSMessage } from '../src/ws-server.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 插件挂载路径与 tokenSecret：apply 的配置与 token 计算共用。 */
const MOUNT_PATH = '/api/cross-transfer'
const TOKEN_SECRET = 'limits-token-secret'
const PASSWORD = 'limits-pass-123'

interface RestRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

interface LimitsHarness {
  ctx: Context
  http: HTTPServer
  httpBaseUrl: string
  wsBaseUrl: string
  clients: TestClient[]
  restRoutes: RestRoute[]
  upgradeRoutes: UpgradeRoute[]
}

const harnesses: LimitsHarness[] = []

/** 夹具配方照 test/rooms.e2e.test.ts：fake webServer 只记录路由登记，真实请求由测试自己的 http server 转交。 */
async function createLimitHarness(rooms: Partial<RoomConfig> = {}): Promise<LimitsHarness> {
  const ctx = new Context()
  const restRoutes: RestRoute[] = []
  const upgradeRoutes: UpgradeRoute[] = []

  const fakeWebServer = {
    register(entry: RestRoute) {
      restRoutes.push(entry)
      return () => {
        const idx = restRoutes.indexOf(entry)
        if (idx >= 0) restRoutes.splice(idx, 1)
      }
    },
    registerUpgrade(entry: UpgradeRoute) {
      upgradeRoutes.push(entry)
      return () => {
        const idx = upgradeRoutes.indexOf(entry)
        if (idx >= 0) upgradeRoutes.splice(idx, 1)
      }
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

  const h: LimitsHarness = {
    ctx,
    http,
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    clients: [],
    restRoutes,
    upgradeRoutes
  }
  harnesses.push(h)
  return h
}

type MsgWaiter = {
  pred: (m: WSMessage) => boolean
  resolve: (m: WSMessage) => void
  timer: ReturnType<typeof setTimeout>
}

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

/** 轮询式等待，不用固定长 sleep。 */
async function until(cond: () => boolean, timeoutMs = 5000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await sleep(20)
  }
}

/** 全量扫描等待某类帧（不推进游标），用于顺序不确定的广播断言。 */
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

/** 负向断言的静默窗口：给「不该发生的投递」留出到达的机会，再确认没出现。 */
async function expectSilence(client: TestClient, pred: (m: WSMessage) => boolean, windowMs = 300): Promise<void> {
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
  h: LimitsHarness,
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

/** 与 ws-server.validateToken 相同的 token 计算。 */
function makeDeviceToken(deviceId: string): string {
  return createHash('sha256').update(`${deviceId}:${TOKEN_SECRET}`).digest('hex')
}

interface Member {
  client: TestClient
  sessionId: string
  deviceId: string
  deviceSecret: string
  deviceName: string
}

/** 真实流程：REST /devices/register 登记凭据，再用返回的 token 建 WS 连接。 */
async function connectDevice(h: LimitsHarness, deviceName: string): Promise<Member> {
  const registered = await httpJson(h, 'POST', '/devices/register', { body: { deviceName } })
  expect(registered.status).toBe(200)
  expect(typeof registered.body.deviceSecret).toBe('string')

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

/** 同设备再开一个会话（同一 deviceId + token）。 */
async function openSecondSession(h: LimitsHarness, member: Member): Promise<TestClient> {
  const client = await TestClient.open(`${h.wsBaseUrl}${MOUNT_PATH}`, {
    deviceId: member.deviceId,
    token: makeDeviceToken(member.deviceId),
    deviceName: member.deviceName
  })
  h.clients.push(client)
  await client.waitFor(m => m.type === 'welcome')
  return client
}

/** 只登记 REST 凭据，不开 WS（并发抢位用 REST 打）。 */
async function registerOnly(h: LimitsHarness, deviceName: string): Promise<{ deviceId: string; deviceSecret: string }> {
  const res = await httpJson(h, 'POST', '/devices/register', { body: { deviceName } })
  expect(res.status).toBe(200)
  return { deviceId: res.body.deviceId, deviceSecret: res.body.deviceSecret }
}

let rpcSeq = 0

/** 发送带 messageId 的请求帧，等待同 messageId 的应答（成功帧或 error 帧）。 */
async function rpc(client: TestClient, type: string, payload: unknown, messageId: string): Promise<WSMessage> {
  client.send({ type, payload, messageId })
  return client.waitFor(m => m.messageId === messageId, 8000)
}

function errCode(reply: WSMessage): string {
  return (reply.payload as { code?: string })?.code ?? '<no-code>'
}

async function createRoomWs(member: Member, roomId: string, password: string, maxMembers?: number): Promise<RoomJoinResult> {
  const payload: Record<string, unknown> = { roomId, password, name: '攻击测试房' }
  if (maxMembers !== undefined) payload.maxMembers = maxMembers
  const reply = await rpc(member.client, 'room-create', payload, `create-${roomId}-${++rpcSeq}`)
  expect(reply.type, `room-create(${roomId}) 失败: ${JSON.stringify(reply.payload)}`).toBe('room-created')
  return reply.payload as RoomJoinResult
}

async function joinRoomWs(member: Member, roomId: string, password: string): Promise<RoomJoinResult> {
  const reply = await rpc(member.client, 'room-join', { roomId, password }, `join-${roomId}-${++rpcSeq}`)
  expect(reply.type, `room-join(${roomId}) 失败: ${JSON.stringify(reply.payload)}`).toBe('room-joined')
  return reply.payload as RoomJoinResult
}

async function createRoomRest(h: LimitsHarness, member: Member, roomId: string): Promise<HttpResult> {
  return httpJson(h, 'POST', '/rooms/create', {
    authorization: `Bearer ${member.deviceSecret}`,
    body: { roomId, password: PASSWORD }
  })
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
// 容量
// ---------------------------------------------------------------------------

describe('容量与生命周期边界（真实宿主接线）', () => {
  describe('容量', () => {
    it('并发进房抢最后一个名额：三人同时抢一个余位，只放进一人且成员数不超上限', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      const created = await httpJson(h, 'POST', '/rooms/create', {
        authorization: `Bearer ${owner.deviceSecret}`,
        body: { roomId: '700100', password: PASSWORD, maxMembers: 2 }
      })
      expect(created.status).toBe(200)
      const ownerTicket: string = created.body.ticket.ticket

      const joiners = []
      for (let i = 0; i < 3; i++) joiners.push(await registerOnly(h, `Racer-${i}`))
      const attempts = await Promise.all(joiners.map(j =>
        httpJson(h, 'POST', '/rooms/join', { body: { roomId: '700100', password: PASSWORD, deviceSecret: j.deviceSecret } })
      ))

      const ok = attempts.filter(r => r.status === 200)
      const full = attempts.filter(r => r.status === 409 && r.body?.error?.code === 'room-full')
      expect(ok, `应只有一个赢家，实际: ${JSON.stringify(attempts.map(a => a.status))}`).toHaveLength(1)
      expect(full).toHaveLength(2)

      // 胜者真的成了成员，且房间没有超员（成员视图一律脱敏，按脱敏 id 比对）
      const listed = await httpJson(h, 'GET', '/rooms/700100/members', { authorization: `Bearer ${ownerTicket}` })
      expect(listed.status).toBe(200)
      expect(listed.body.members).toHaveLength(2)
      const memberIds = (listed.body.members as Array<{ deviceId: string }>).map(m => m.deviceId)
      const winners = joiners.filter(j => memberIds.includes(maskDeviceId(j.deviceId)))
      expect(winners).toHaveLength(1)
    })

    it('房间满员后，密码正确的新设备也被拒（room-full），成员数保持不变', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '700200', PASSWORD, 2)
      const first = await connectDevice(h, 'First')
      await joinRoomWs(first, '700200', PASSWORD)

      const late = await connectDevice(h, 'Late')
      const reply = await rpc(late.client, 'room-join', { roomId: '700200', password: PASSWORD }, `full-${++rpcSeq}`)
      expect(reply.type).toBe('error')
      expect(errCode(reply)).toBe('room-full')

      const listed = await rpc(owner.client, 'room-members', { roomId: '700200' }, `members-${++rpcSeq}`)
      expect(listed.type).toBe('room-members')
      expect((listed.payload as { members: unknown[] }).members).toHaveLength(2)
    })

    it('建房 maxMembers 被夹到全局上限 16，0/负数/非整数被拒（invalid-argument）', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')

      const big = await rpc(owner.client, 'room-create', { roomId: '700310', password: PASSWORD, maxMembers: 9999 }, `big-${++rpcSeq}`)
      expect(big.type).toBe('room-created')
      expect((big.payload as RoomJoinResult).room.maxMembers).toBe(16)

      const badIds = ['700321', '700322', '700323']
      for (const [i, bad] of [0, -1, 2.5].entries()) {
        const reply = await rpc(owner.client, 'room-create', { roomId: badIds[i], password: PASSWORD, maxMembers: bad }, `bad-${i}-${++rpcSeq}`)
        expect(reply.type, `maxMembers=${bad} 应被拒: ${JSON.stringify(reply.payload)}`).toBe('error')
        expect(errCode(reply)).toBe('invalid-argument')
      }
    })
  })

  // -------------------------------------------------------------------------
  // 同一设备与多会话
  // -------------------------------------------------------------------------

  describe('同一设备与多会话', () => {
    it('同一设备重复进同一房间：不产生第二个成员行，成员计数不涨', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '700400', PASSWORD)
      const member = await connectDevice(h, 'Member')
      await joinRoomWs(member, '700400', PASSWORD)

      // 同一会话再进一次
      const again = await rpc(member.client, 'room-join', { roomId: '700400', password: PASSWORD }, `again-${++rpcSeq}`)
      expect(again.type).toBe('room-joined')

      // 成员视图一律脱敏（契约 §1.1），按脱敏 id 找他的成员行
      const rowsOf = async () => {
        const listed = await rpc(owner.client, 'room-members', { roomId: '700400' }, `rows-${++rpcSeq}`)
        return (listed.payload as { members: Array<{ deviceId: string }> }).members
      }
      expect((await rowsOf()).filter(m => m.deviceId === maskDeviceId(member.deviceId))).toHaveLength(1)
      expect(await rowsOf()).toHaveLength(2)

      // REST 再进一次同样不得重复
      const rest = await httpJson(h, 'POST', '/rooms/join', { body: { roomId: '700400', password: PASSWORD, deviceSecret: member.deviceSecret } })
      expect(rest.status).toBe(200)
      expect(await rowsOf()).toHaveLength(2)
    })

    it('同一设备两个会话同房，断开其一：另一会话仍是成员（不误删），断开的会话不再计数（不残留）', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '700500', PASSWORD)
      const member = await connectDevice(h, 'Member')
      const s1 = member.client
      const s2 = await openSecondSession(h, member)

      await joinRoomWs(member, '700500', PASSWORD)
      // 第二个会话凭成员快速通道回房：契约 §1.8 第 2 步明文允许不比对密码
      const fast = await rpc(s2, 'room-join', { roomId: '700500', password: 'wrong-pass-9' }, `fast-${++rpcSeq}`)
      expect(fast.type).toBe('room-joined')

      const rowOf = async () => {
        const listed = await rpc(owner.client, 'room-members', { roomId: '700500' }, `row-${++rpcSeq}`)
        const members = (listed.payload as { members: Array<{ deviceId: string; online: boolean; sessionCount: number }> }).members
        // 成员视图一律脱敏（契约 §1.1），按脱敏 id 找他的成员行
        return members.find(m => m.deviceId === maskDeviceId(member.deviceId))
      }
      let row = await rowOf()
      expect(row?.online).toBe(true)
      expect(row?.sessionCount).toBe(2)

      // 断开其中一个会话：成员行必须还在（不误删），但断开的会话不能再计数（不残留）
      s1.close(1000, 'tab closed')
      await waitForAny(owner.client, m => m.type === 'user-left')
      row = await rowOf()
      expect(row, '成员行不得被误删').toBeTruthy()
      expect(row!.online).toBe(true)
      expect(row!.sessionCount).toBe(1)

      // 剩下的会话还能正常发言：它仍是成员
      s2.send({ type: 'chat-message', payload: { roomId: '700500', content: '还在' }, messageId: `still-${++rpcSeq}` })
      const ack = await s2.waitFor(m => m.type === 'chat-message-ack')
      expect(ack.type).toBe('chat-message-ack')

      // 最后一个会话也断开：席位按契约保留为离线，行不删
      s2.close(1000, 'last tab closed')
      await until(
        () => owner.client.messages.filter(m => m.type === 'user-left' && (m.payload as { deviceId?: string })?.deviceId === member.deviceId).length >= 2,
        5000,
        '两次 user-left'
      )
      row = await rowOf()
      expect(row, '席位保留：成员行仍在').toBeTruthy()
      expect(row!.online).toBe(false)
      expect(row!.sessionCount).toBe(0)
    })

    it('断开多会话之一后，仍在线会话的票据不应被连带吊销（契约：断线不在票据吊销清单里）', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '700600', PASSWORD)
      const member = await connectDevice(h, 'Member')
      const s2 = await openSecondSession(h, member)

      await joinRoomWs(member, '700600', PASSWORD)
      const joined = await rpc(s2, 'room-join', { roomId: '700600', password: PASSWORD }, `s2-${++rpcSeq}`)
      expect(joined.type).toBe('room-joined')
      const s2Ticket: string = (joined.payload as RoomJoinResult).ticket.ticket

      member.client.close(1000, 'one tab closed')
      await waitForAny(owner.client, m => m.type === 'user-left')

      // 另一个会话还在线、还是成员：它的 REST 票据应当仍然有效（吊销清单只有退房/被踢/关房/改密/回收）
      const hist = await httpJson(h, 'GET', '/chat/history?roomId=700600', { authorization: `Bearer ${s2Ticket}` })
      expect(hist.status, `仍在线会话的票据被连带吊销: ${JSON.stringify(hist.body)}`).toBe(200)
      expect(Array.isArray(hist.body.messages)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // 锁定与准入
  // -------------------------------------------------------------------------

  describe('锁定与准入', () => {
    it('锁定房间后，知道正确密码的新设备被拒（room-locked），已退房的前成员同样进不来', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '700700', PASSWORD)
      const member = await connectDevice(h, 'Member')
      await joinRoomWs(member, '700700', PASSWORD)

      // 成员先退房：成员行删除，之后只剩「密码」这一条路
      const left = await rpc(member.client, 'room-leave', { roomId: '700700' }, `leave-${++rpcSeq}`)
      expect(left.type).toBe('room-left')

      const locked = await rpc(owner.client, 'room-lock', { roomId: '700700', locked: true }, `lock-${++rpcSeq}`)
      expect(locked.type).toBe('room-locked')

      const newcomer = await connectDevice(h, 'Newcomer')
      const rej = await rpc(newcomer.client, 'room-join', { roomId: '700700', password: PASSWORD }, `rej-${++rpcSeq}`)
      expect(rej.type).toBe('error')
      expect(errCode(rej)).toBe('room-locked')

      // 前成员知道密码也不行：成员行已删，锁对他同样生效
      const back = await rpc(member.client, 'room-join', { roomId: '700700', password: PASSWORD }, `back-${++rpcSeq}`)
      expect(back.type).toBe('error')
      expect(errCode(back)).toBe('room-locked')
    })

    it('从未登记的设备即使换到合法连接 token，进房也被拒（invalid-device），且对存在/不存在的房号错误码一致', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '700800', PASSWORD)

      // legacy /token 回落：自报 deviceId 就能换到连接 token，连接层拦不住它
      const ghost = 'ghost-device-0001'
      const tok = await httpJson(h, 'POST', '/devices/token', { body: { deviceId: ghost } })
      expect(tok.status).toBe(200)
      const ghostClient = await TestClient.open(`${h.wsBaseUrl}${MOUNT_PATH}`, { deviceId: ghost, token: tok.body.token })
      h.clients.push(ghostClient)
      await ghostClient.waitFor(m => m.type === 'welcome')

      const rej = await rpc(ghostClient, 'room-join', { roomId: '700800', password: PASSWORD }, `ghost-${++rpcSeq}`)
      expect(rej.type).toBe('error')
      expect(errCode(rej)).toBe('invalid-device')

      // 错误码不得泄露房号是否存在
      const probe = await rpc(ghostClient, 'room-join', { roomId: '999999', password: PASSWORD }, `probe-${++rpcSeq}`)
      expect(probe.type).toBe('error')
      expect(errCode(probe)).toBe('invalid-device')
    })

    it('锁定房间后，冒用已登记设备 deviceId 的连接不输密码仍能进房、读走聊天记录并关房（legacy /token 回落伪造会话身份）', async () => {
      const h = await createLimitHarness()
      const victim = await connectDevice(h, 'Victim')
      await createRoomWs(victim, '700900', PASSWORD)
      const member = await connectDevice(h, 'Member')
      await joinRoomWs(member, '700900', PASSWORD)

      // 房内已有内容，且房间已上锁：锁应当挡住一切没有成员行的连接
      member.client.send({ type: 'chat-message', payload: { roomId: '700900', content: '成员的私密消息' }, messageId: `seed-${++rpcSeq}` })
      await member.client.waitFor(m => m.type === 'chat-message-ack')
      const lock = await rpc(victim.client, 'room-lock', { roomId: '700900', locked: true }, `lock-${++rpcSeq}`)
      expect(lock.type).toBe('room-locked')

      // 攻击：legacy /token 回落给任意自报 deviceId 发连接 token，冒充房主设备接入。
      // 无论修复形态是拒连接还是拒帧，冒用会话都不得以成员身份拿到任何东西。
      let joined = false
      let detail = ''
      try {
        const stolen = await httpJson(h, 'POST', '/devices/token', { body: { deviceId: victim.deviceId } })
        const attacker = await TestClient.open(`${h.wsBaseUrl}${MOUNT_PATH}`, { deviceId: victim.deviceId, token: stolen.body.token })
        h.clients.push(attacker)
        await attacker.waitFor(m => m.type === 'welcome')

        const join = await rpc(attacker, 'room-join', { roomId: '700900', password: 'guess-pass-9' }, `hijack-${++rpcSeq}`)
        // 先取证再断言：把冒用会话实际拿到的东西写进失败信息
        const hist = await rpc(attacker, 'chat-history-request', { roomId: '700900' }, `hist-${++rpcSeq}`)
        const close = await rpc(attacker, 'room-close', { roomId: '700900' }, `close-${++rpcSeq}`)
        joined = join.type === 'room-joined'
        detail = `join=${join.type} role=${(join.payload as { member?: { role?: string } })?.member?.role} hist=${JSON.stringify(hist.payload).slice(0, 140)} close=${close.type}`
      } catch (error) {
        // 连接或应答层被拒（如 token 换不到、握手被掐）也是「拒绝」的一种实现
        detail = `rejected at transport: ${(error as Error).message}`
      }
      expect(joined, `冒用已登记设备的会话进来了: ${detail}`).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  describe('生命周期', () => {
    it('房主退房后房间按默认配置关闭：成员收到 owner-left 关房通知，旧票据失效，再进命中墓碑', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '701000', PASSWORD)
      const member = await connectDevice(h, 'Member')
      const joined = await joinRoomWs(member, '701000', PASSWORD)
      const ticket: string = joined.ticket.ticket

      const left = await rpc(owner.client, 'room-leave', { roomId: '701000' }, `leave-${++rpcSeq}`)
      expect(left.type).toBe('room-left')
      expect((left.payload as RoomLeaveResult).closed).toBe(true)

      const notice = await waitForAny(member.client, m => m.type === 'room-closed' && m.messageId === undefined)
      expect(notice.payload).toEqual({ roomId: '701000', reason: 'owner-left' })

      // 关房吊销成员票据
      const hist = await httpJson(h, 'GET', '/chat/history?roomId=701000', { authorization: `Bearer ${ticket}` })
      expect(hist.status).toBe(401)
      expect(hist.body.error.code).toBe('invalid-ticket')

      // 再进命中墓碑
      const again = await rpc(member.client, 'room-join', { roomId: '701000', password: PASSWORD }, `again-${++rpcSeq}`)
      expect(again.type).toBe('error')
      expect(errCode(again)).toBe('room-closed')
    })

    it('普通成员退房不关房：房主收到 user-left（reason=left），房间对新成员仍然可进', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '701100', PASSWORD)
      const member = await connectDevice(h, 'Member')
      await joinRoomWs(member, '701100', PASSWORD)

      const left = await rpc(member.client, 'room-leave', { roomId: '701100' }, `leave-${++rpcSeq}`)
      expect(left.type).toBe('room-left')
      expect((left.payload as RoomLeaveResult)).toMatchObject({ removed: true, closed: false })

      const notice = await waitForAny(owner.client, m => m.type === 'user-left')
      expect(notice.payload).toEqual({ roomId: '701100', deviceId: member.deviceId, reason: 'left' })

      const newcomer = await connectDevice(h, 'Newcomer')
      const ok = await joinRoomWs(newcomer, '701100', PASSWORD)
      expect(ok.member.role).toBe('member')
    })

    it('空闲超时回收真的回收：房主断线后房间被回收，成员收到 idle-timeout 通知，旧票据失效', async () => {
      const h = await createLimitHarness({ idleTtlMs: 1500 })
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '701200', PASSWORD)
      const member = await connectDevice(h, 'Member')
      const joined = await joinRoomWs(member, '701200', PASSWORD)
      const ticket: string = joined.ticket.ticket

      // 房主断线：ownerOfflineSince 从此刻起算，超过 idleTtlMs 后应被回收（即使成员还在线）
      owner.client.close(1000, 'owner gone')
      const notice = await waitForAny(member.client, m => m.type === 'room-closed' && m.messageId === undefined, 8000)
      expect(notice.payload).toEqual({ roomId: '701200', reason: 'idle-timeout' })

      // 被回收后旧票据失效
      const hist = await httpJson(h, 'GET', '/chat/history?roomId=701200', { authorization: `Bearer ${ticket}` })
      expect(hist.status).toBe(401)
      expect(hist.body.error.code).toBe('invalid-ticket')

      // 成员的会话也不再有任何成员资格
      const chat = await rpc(member.client, 'chat-message', { roomId: '701200', content: '还有人在吗' }, `chat-${++rpcSeq}`)
      expect(chat.type).toBe('error')
      expect(errCode(chat)).toBe('not-a-member')

      // 新设备进房：命中墓碑
      const newcomer = await connectDevice(h, 'Newcomer')
      const rej = await rpc(newcomer.client, 'room-join', { roomId: '701200', password: PASSWORD }, `rej-${++rpcSeq}`)
      expect(rej.type).toBe('error')
      expect(errCode(rej)).toBe('room-closed')
    })

    it('房间总数上限生效：达到 maxRooms 后拒绝（too-many-rooms），关房后名额释放', async () => {
      const h = await createLimitHarness({ maxRooms: 2 })
      const owner = await connectDevice(h, 'Owner')

      const t1 = await createRoomRest(h, owner, '701300')
      expect(t1.status).toBe(200)
      const t2 = await createRoomRest(h, owner, '701400')
      expect(t2.status).toBe(200)
      const t3 = await createRoomRest(h, owner, '701500')
      expect(t3.status).toBe(429)
      expect(t3.body.error.code).toBe('too-many-rooms')

      // 关掉一间，名额立刻释放
      const close = await httpJson(h, 'POST', '/rooms/701400/close', {
        authorization: `Bearer ${(t2.body as RoomJoinResult).ticket.ticket}`,
        body: {}
      })
      expect(close.status).toBe(200)
      const t4 = await createRoomRest(h, owner, '701500')
      expect(t4.status).toBe(200)
    })

    it('并发建房在还有名额时不得被误拒：maxRooms=2 时 4 个并发建房应恰好放进 2 个', async () => {
      const h = await createLimitHarness({ maxRooms: 2, maxRoomsPerDevice: 50 })
      const owner = await connectDevice(h, 'Owner')
      const ids = ['701601', '701602', '701603', '701604']

      const results = await Promise.all(ids.map(id => createRoomRest(h, owner, id)))
      const ok = results.filter(r => r.status === 200)
      const rejected = results.filter(r => r.status === 429 && r.body?.error?.code === 'too-many-rooms')
      // 上限是 2 就该放 2 个：占位若被正确计数一次，前两个占住名额、后两个被拒
      expect(ok, `实际: ${JSON.stringify(results.map(r => ({ s: r.status, b: r.body })))}`).toHaveLength(2)
      expect(rejected).toHaveLength(2)
    })

    it('同号建房被拒（room-exists）；并发抢同一个房号只有一个成功', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      const other = await connectDevice(h, 'Other')
      await createRoomWs(owner, '701700', PASSWORD)

      const dupOwner = await createRoomRest(h, owner, '701700')
      expect(dupOwner.status).toBe(409)
      expect(dupOwner.body.error.code).toBe('room-exists')

      const dupOther = await httpJson(h, 'POST', '/rooms/create', {
        authorization: `Bearer ${other.deviceSecret}`,
        body: { roomId: '701700', password: PASSWORD }
      })
      expect(dupOther.status).toBe(409)
      expect(dupOther.body.error.code).toBe('room-exists')

      const results = await Promise.all([1, 2, 3, 4].map(() => createRoomRest(h, owner, '701800')))
      expect(results.filter(r => r.status === 200)).toHaveLength(1)
      expect(results.filter(r => r.status === 409 && r.body?.error?.code === 'room-exists')).toHaveLength(3)
    })

    it('每设备建房上限生效：超过 maxRoomsPerDevice 被拒，但别的设备不受影响', async () => {
      const h = await createLimitHarness({ maxRooms: 50, maxRoomsPerDevice: 2 })
      const owner = await connectDevice(h, 'Owner')

      expect((await createRoomRest(h, owner, '701900')).status).toBe(200)
      expect((await createRoomRest(h, owner, '702000')).status).toBe(200)
      const third = await createRoomRest(h, owner, '702100')
      expect(third.status).toBe(429)
      expect(third.body.error.code).toBe('too-many-rooms')

      const other = await connectDevice(h, 'Other')
      const ok = await createRoomRest(h, other, '702100')
      expect(ok.status).toBe(200)
    })
  })

  // -------------------------------------------------------------------------
  // 房主权限与成员可见性
  // -------------------------------------------------------------------------

  describe('房主权限与成员可见性', () => {
    it('非房主执行关房/改密/锁房/踢人一律被拒（forbidden）：WS 与 REST 一致，房间不受影响', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '702200', PASSWORD)
      const member = await connectDevice(h, 'Member')
      const joined = await joinRoomWs(member, '702200', PASSWORD)
      const ticket: string = joined.ticket.ticket

      // WS 面
      const wsClose = await rpc(member.client, 'room-close', { roomId: '702200' }, `c-${++rpcSeq}`)
      expect(wsClose.type).toBe('error')
      expect(errCode(wsClose)).toBe('forbidden')
      const wsPass = await rpc(member.client, 'room-password', { roomId: '702200', password: 'new-pass-99' }, `p-${++rpcSeq}`)
      expect(wsPass.type).toBe('error')
      expect(errCode(wsPass)).toBe('forbidden')
      const wsLock = await rpc(member.client, 'room-lock', { roomId: '702200', locked: true }, `l-${++rpcSeq}`)
      expect(wsLock.type).toBe('error')
      expect(errCode(wsLock)).toBe('forbidden')
      const wsKick = await rpc(member.client, 'room-kick', { roomId: '702200', deviceId: owner.deviceId }, `k-${++rpcSeq}`)
      expect(wsKick.type).toBe('error')
      expect(errCode(wsKick)).toBe('forbidden')

      // REST 面（成员票据 role=member）
      const restClose = await httpJson(h, 'POST', '/rooms/702200/close', { authorization: `Bearer ${ticket}`, body: {} })
      expect(restClose.status).toBe(403)
      expect(restClose.body.error.code).toBe('forbidden')
      const restPass = await httpJson(h, 'POST', '/rooms/702200/password', { authorization: `Bearer ${ticket}`, body: { password: 'new-pass-99' } })
      expect(restPass.status).toBe(403)
      expect(restPass.body.error.code).toBe('forbidden')
      const restLock = await httpJson(h, 'POST', '/rooms/702200/lock', { authorization: `Bearer ${ticket}`, body: { locked: true } })
      expect(restLock.status).toBe(403)
      expect(restLock.body.error.code).toBe('forbidden')

      // 房间毫发无损：新成员还能按原密码进
      const newcomer = await connectDevice(h, 'Newcomer')
      const ok = await joinRoomWs(newcomer, '702200', PASSWORD)
      expect(ok.member.role).toBe('member')
    })

    it('非成员关房被拒（not-a-member）；REST 删人只支持自助退房，删别人被拒（forbidden）', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '702300', PASSWORD)
      const member = await connectDevice(h, 'Member')
      const joined = await joinRoomWs(member, '702300', PASSWORD)
      const ticket: string = joined.ticket.ticket
      const outsider = await connectDevice(h, 'Outsider')

      const close = await rpc(outsider.client, 'room-close', { roomId: '702300' }, `oc-${++rpcSeq}`)
      expect(close.type).toBe('error')
      expect(errCode(close)).toBe('not-a-member')

      // 成员票据删别人（房主）→ forbidden，房主仍在
      const delOther = await httpJson(h, 'DELETE', `/rooms/702300/members/${owner.deviceId}`, { authorization: `Bearer ${ticket}` })
      expect(delOther.status).toBe(403)
      expect(delOther.body.error.code).toBe('forbidden')

      // 无票据 → 401
      const naked = await httpJson(h, 'DELETE', `/rooms/702300/members/${member.deviceId}`)
      expect(naked.status).toBe(401)
      expect(naked.body.error.code).toBe('invalid-ticket')

      // 自助退房 → 200，成员行移除
      const self = await httpJson(h, 'DELETE', `/rooms/702300/members/${member.deviceId}`, { authorization: `Bearer ${ticket}` })
      expect(self.status).toBe(200)
      expect(self.body).toMatchObject({ roomId: '702300', deviceId: member.deviceId, removed: true, self: true })
    })

    it('被踢的人收到 member-kicked 通知后，收不到任何后续房间广播，票据与成员资格同时失效', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '702400', PASSWORD)
      const member = await connectDevice(h, 'Member')
      await joinRoomWs(member, '702400', PASSWORD)
      const kicked = await connectDevice(h, 'Kicked')
      const kj = await joinRoomWs(kicked, '702400', PASSWORD)
      const kickedTicket: string = kj.ticket.ticket

      // 成员列表一律脱敏（契约 §1.1）：房主确认目标在列，但真实 id 从自己收到的
      // user-joined 推送/登记记录里拿（kicked.deviceId），不从列表反查。
      const listed = await rpc(owner.client, 'room-members', { roomId: '702400' }, `list-${++rpcSeq}`)
      const members = (listed.payload as { members: Array<{ deviceId: string; deviceName: string }> }).members
      const target = members.find(m => m.deviceName === 'Kicked')
      expect(target).toBeTruthy()

      const kick = await rpc(owner.client, 'room-kick', { roomId: '702400', deviceId: kicked.deviceId }, `kick-${++rpcSeq}`)
      expect(kick.type).toBe('room-member-kicked')

      // 被踢者收到通知
      const notice = await waitForAny(kicked.client, m => m.type === 'room-member-kicked')
      expect(notice.payload).toMatchObject({ roomId: '702400', deviceId: kicked.deviceId, kickedByDeviceId: owner.deviceId })

      // 后续广播一条收不到
      owner.client.send({ type: 'chat-message', payload: { roomId: '702400', content: '内部广播' }, messageId: `bc-${++rpcSeq}` })
      await owner.client.waitFor(m => m.type === 'chat-message-ack')
      await expectSilence(kicked.client, m =>
        m.type === 'chat-message' || m.type === 'chat-message-ack' || m.type === 'user-joined' || m.type === 'room-closed' || m.type === 'room-locked'
      )

      // 成员资格与票据同时失效
      const chat = await rpc(kicked.client, 'chat-message', { roomId: '702400', content: '我还在吗' }, `kc-${++rpcSeq}`)
      expect(chat.type).toBe('error')
      expect(errCode(chat)).toBe('not-a-member')
      const hist = await httpJson(h, 'GET', '/chat/history?roomId=702400', { authorization: `Bearer ${kickedTicket}` })
      expect(hist.status).toBe(401)
      expect(hist.body.error.code).toBe('invalid-ticket')
    })

    it('非成员读成员列表被拒：WS not-a-member，跨房票据与无票据都是 invalid-ticket，deviceSecret 不是房间票据', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomWs(owner, '702500', PASSWORD)
      const outsider = await connectDevice(h, 'Outsider')

      const ws = await rpc(outsider.client, 'room-members', { roomId: '702500' }, `ws-${++rpcSeq}`)
      expect(ws.type).toBe('error')
      expect(errCode(ws)).toBe('not-a-member')

      // 房主在另一间房的票据，拿来读这一间 → 跨房票据无效
      const other = await createRoomWs(owner, '702600', PASSWORD)
      const cross = await httpJson(h, 'GET', '/rooms/702500/members', { authorization: `Bearer ${other.ticket.ticket}` })
      expect(cross.status).toBe(401)
      expect(cross.body.error.code).toBe('invalid-ticket')
      expect(cross.body.members).toBeUndefined()

      const naked = await httpJson(h, 'GET', '/rooms/702500/members')
      expect(naked.status).toBe(401)
      expect(naked.body.error.code).toBe('invalid-ticket')
      expect(naked.body.members).toBeUndefined()

      // deviceSecret 能证明身份，但不是房间票据
      const secret = await httpJson(h, 'GET', '/rooms/702500/members', { authorization: `Bearer ${outsider.deviceSecret}` })
      expect(secret.status).toBe(401)
      expect(secret.body.error.code).toBe('invalid-ticket')
    })
  })

  // -------------------------------------------------------------------------
  // 房号格式
  // -------------------------------------------------------------------------

  describe('房号格式', () => {
    it('非法房号一律被拒：REST 建房/进房 400 invalid-room-id，WS error 帧，太短太长带字母带符号都不放行', async () => {
      const h = await createLimitHarness()
      const owner = await connectDevice(h, 'Owner')
      const badIds = ['abcdef', '123', '1234567890123', '12a45', '70-00']

      for (const bad of badIds) {
        const created = await httpJson(h, 'POST', '/rooms/create', {
          authorization: `Bearer ${owner.deviceSecret}`,
          body: { roomId: bad, password: PASSWORD }
        })
        expect(created.status, `roomId=${bad} 应被 400 拒绝`).toBe(400)
        expect(created.body.error.code, `roomId=${bad}`).toBe('invalid-room-id')
      }

      const joined = await httpJson(h, 'POST', '/rooms/join', { body: { roomId: 'abcdef', password: PASSWORD, deviceSecret: owner.deviceSecret } })
      expect(joined.status).toBe(400)
      expect(joined.body.error.code).toBe('invalid-room-id')

      const ws = await rpc(owner.client, 'room-join', { roomId: 'abc', password: PASSWORD }, `bad-${++rpcSeq}`)
      expect(ws.type).toBe('error')
      expect(errCode(ws)).toBe('invalid-room-id')

      // 路径里塞非法房号也探不到东西：未列出的子路径按 404 处理
      const weirdGet = await httpJson(h, 'GET', '/rooms/abcdef/members')
      expect(weirdGet.status).toBe(404)
      expect(weirdGet.body.members).toBeUndefined()
    })
  })
})
