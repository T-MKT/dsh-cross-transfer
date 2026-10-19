/**
 * 房间门禁安全探针：密码这道门 + 票据 + 冒充 + 限流 + 信息泄漏。
 *
 * 与验收测试的分工：这里每条用例都是一次主动攻击，断言的是冻结契约要求的
 * 「系统应当具备的性质」。红 = 找到一个洞；绿 = 该防线在真实路径上成立。
 * 全部走真实宿主接线（apply + 真实 http server + 真实 ws 客户端），
 * 不直接 new 服务类——门禁的价值就在于真实路径上成立。
 *
 * 跑法：node node_modules/vitest/vitest.mjs run test/rooms-security.test.ts
 */
import { describe, it, expect, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { Duplex } from 'stream'
import { WebSocket } from 'ws'
import { apply } from '../src/index.js'
import { DEFAULT_ROOM_CONFIG, maskDeviceId, type RoomConfig, type RoomJoinResult } from '../src/rooms.js'
import type { WSMessage } from '../src/ws-server.js'

// ---------------------------------------------------------------------------
// 夹具：照 test/rooms.e2e.test.ts 的配方，apply + fake webServer + 真实 server
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const MOUNT_PATH = '/api/cross-transfer'
const TOKEN_SECRET = 'security-probe-secret'
const PASSWORD = 'right-pass-123'
const WRONG_PASSWORD = 'wrong-pass-456'
const SECRET_MESSAGE = '房主的私有计划：周五凌晨三点行动'

interface RestRoute {
  kind: string
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

interface UpgradeRoute {
  path: string
  handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
}

interface SecurityHarness {
  ctx: Context
  http: HTTPServer
  httpBaseUrl: string
  wsBaseUrl: string
  clients: TestClient[]
}

const harnesses: SecurityHarness[] = []

async function createSecurityHarness(rooms: Partial<RoomConfig> = {}): Promise<SecurityHarness> {
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

  const h: SecurityHarness = {
    ctx,
    http,
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    clients: []
  }
  harnesses.push(h)
  return h
}

// ---------------------------------------------------------------------------
// WS 测试客户端：轮询式等待，不用固定长 sleep
// ---------------------------------------------------------------------------

type MsgWaiter = {
  pred: (m: WSMessage) => boolean
  resolve: (m: WSMessage) => void
  timer: ReturnType<typeof setTimeout>
}

class TestClient {
  readonly ws: WebSocket
  readonly messages: WSMessage[] = []
  readonly closed: Promise<{ code: number; reason: string }>
  private cursor = 0
  private msgWaiters: MsgWaiter[] = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.closed = new Promise(resolve => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
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

  static open(h: SecurityHarness, params: Record<string, string> = {}): Promise<TestClient> {
    const url = new URL(`${h.wsBaseUrl}${MOUNT_PATH}`)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
    const client = new TestClient(url.toString())
    h.clients.push(client)
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

  received(type: string): boolean {
    return this.messages.some(m => m.type === type)
  }

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

/** 全量扫描等待某类帧（不推进游标），顺序不确定的广播用它。 */
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

/** 负向断言的静默窗口：给「不该发生的投递」留出到达机会，再确认没出现。 */
async function expectSilence(client: TestClient, pred: (m: WSMessage) => boolean, windowMs = 250): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < windowMs) {
    const found = client.messages.find(pred)
    if (found) throw new Error(`unexpected frame received: ${JSON.stringify(found)}`)
    await sleep(20)
  }
}

// ---------------------------------------------------------------------------
// REST / 流程助手
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number
  body: any
  headers: Headers
}

async function httpJson(
  h: SecurityHarness,
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
  return { status: res.status, body, headers: res.headers }
}

interface Member {
  client: TestClient
  sessionId: string
  deviceId: string
  deviceSecret: string
  deviceName: string
}

/** 真实流程：REST /devices/register 登记凭据，再用返回的 token 建 WS 连接。 */
async function connectDevice(h: SecurityHarness, deviceName: string): Promise<Member> {
  const registered = await httpJson(h, 'POST', '/devices/register', { body: { deviceName } })
  expect(registered.status).toBe(200)
  const client = await TestClient.open(h, {
    deviceId: registered.body.deviceId,
    token: registered.body.token,
    deviceName
  })
  const welcome = await client.waitFor(m => m.type === 'welcome')
  return {
    client,
    sessionId: welcome.sessionId!,
    deviceId: registered.body.deviceId,
    deviceSecret: registered.body.deviceSecret,
    deviceName
  }
}

let rpcSeq = 0

/** 发送带 messageId 的请求帧，等待同 messageId 的应答（成功帧或 error 帧）。 */
async function rpc(client: TestClient, type: string, payload: unknown, messageId: string): Promise<WSMessage> {
  client.send({ type, payload, messageId: `${messageId}-${++rpcSeq}` })
  return client.waitFor(m => m.messageId === `${messageId}-${rpcSeq}`, 8000)
}

async function createRoomViaWs(owner: Member, roomId: string | undefined, password: string, extra: Record<string, unknown> = {}): Promise<RoomJoinResult> {
  const payload: Record<string, unknown> = { password, name: '探针房', ...extra }
  if (roomId !== undefined) payload.roomId = roomId
  const reply = await rpc(owner.client, 'room-create', payload, `create-${roomId ?? 'rand'}`)
  expect(reply.type, `建房应成功：${JSON.stringify(reply.payload)}`).toBe('room-created')
  return reply.payload as RoomJoinResult
}

async function joinRoomViaWs(member: Member, roomId: string, password: string): Promise<RoomJoinResult> {
  const reply = await rpc(member.client, 'room-join', { roomId, password }, `join-${roomId}`)
  expect(reply.type, `进房应成功：${JSON.stringify(reply.payload)}`).toBe('room-joined')
  return reply.payload as RoomJoinResult
}

/** 轮询直到条件成立（票据过期等待用）。 */
async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time')
    await sleep(20)
  }
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
// 密码试错与锁定
// ---------------------------------------------------------------------------

describe('密码试错与锁定', () => {
  it('暴力猜密码：REST 连续 8 次错密码后被锁定，锁定期内正确密码被拒，换新设备同 IP 也被拒', async () => {
    const h = await createSecurityHarness()
    const ownerReg = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Owner' } })
    const created = await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${ownerReg.body.deviceSecret}`,
      body: { roomId: '461001', password: PASSWORD }
    })
    expect(created.status).toBe(200)

    const attacker = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Brute' } })
    const attackerSecret: string = attacker.body.deviceSecret

    // 前 8 次错密码：逐次 401 wrong-password（第 8 次起锁定生效）
    for (let i = 1; i <= 8; i++) {
      const bad = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '461001', password: `${WRONG_PASSWORD}-${i}`, deviceSecret: attackerSecret }
      })
      expect(bad.status, `第 ${i} 次错密码应 401`).toBe(401)
      expect(bad.body.error.code).toBe('wrong-password')
    }

    // 锁定期内：正确密码也必须被拒（限流先于密码比对），且带 retryAfterMs
    const locked = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '461001', password: PASSWORD, deviceSecret: attackerSecret }
    })
    expect(locked.status, '锁定期内正确密码也必须被 429 挡住').toBe(429)
    expect(locked.body.error.code).toBe('too-many-attempts')
    expect(typeof locked.body.error.retryAfterMs).toBe('number')
    expect(locked.body.error.retryAfterMs).toBeGreaterThan(0)
    expect(Number(locked.headers.get('Retry-After'))).toBeGreaterThan(0)

    // 换新设备也绕不过：同 IP 同房间的 ip 维度锁定仍然生效
    const fresh = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Brute-2' } })
    const freshTry = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '461001', password: PASSWORD, deviceSecret: fresh.body.deviceSecret }
    })
    expect(freshTry.status, '换新设备也必须被同 IP 锁定挡住').toBe(429)
    expect(freshTry.body.error.code).toBe('too-many-attempts')
  })

  it('跨面共享：REST 刷满的锁定在 WS 面同样生效，WS 带正确密码也被拒', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '461002', PASSWORD)

    const attacker = await connectDevice(h, 'Brute')
    for (let i = 1; i <= 8; i++) {
      const bad = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '461002', password: `${WRONG_PASSWORD}-${i}`, deviceSecret: attacker.deviceSecret }
      })
      expect(bad.status).toBe(401)
    }

    // 同一设备换 WS 面用正确密码：锁必须跟过来
    const reply = await rpc(attacker.client, 'room-join', { roomId: '461002', password: PASSWORD }, 'ws-locked')
    expect(reply.type, 'REST 刷满的锁定必须在 WS 面同样挡住正确密码').toBe('error')
    expect((reply.payload as { code: string }).code).toBe('too-many-attempts')
  })

  it('设备维度锁定跨房间生效：A 房刷满后 B 房也被拒，但别的设备不受影响', async () => {
    const h = await createSecurityHarness()
    const ownerReg = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Owner' } })
    const ownerSecret: string = ownerReg.body.deviceSecret
    await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${ownerSecret}`,
      body: { roomId: '461003', password: PASSWORD }
    })
    await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${ownerSecret}`,
      body: { roomId: '461004', password: PASSWORD }
    })

    const attacker = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Brute' } })
    const attackerSecret: string = attacker.body.deviceSecret
    for (let i = 1; i <= 8; i++) {
      await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '461003', password: `${WRONG_PASSWORD}-${i}`, deviceSecret: attackerSecret }
      })
    }

    // 同设备换一间房：device 维度的锁定跨房间生效
    const other = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '461004', password: PASSWORD, deviceSecret: attackerSecret }
    })
    expect(other.status, 'A 房刷满后同设备进 B 房也必须被锁').toBe(429)
    expect(other.body.error.code).toBe('too-many-attempts')

    // 对照：别的设备不受牵连（锁定不做全房/全服扩散）
    const bystander = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Bystander' } })
    const ok = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '461004', password: PASSWORD, deviceSecret: bystander.body.deviceSecret }
    })
    expect(ok.status, '无关设备必须不受别人锁定的影响').toBe(200)
  })
})

// ---------------------------------------------------------------------------
// 密码形态与比较
// ---------------------------------------------------------------------------

describe('密码形态与比较', () => {
  it('只差一位 / 大小写差异 / 前置 \\u0000 / 尾随空格都是 wrong-password，不会误匹配', async () => {
    const h = await createSecurityHarness()
    const ownerReg = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Owner' } })
    await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${ownerReg.body.deviceSecret}`,
      body: { roomId: '462001', password: 'Sup3rSecret!' }
    })
    const attacker = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Probe' } })
    const secret: string = attacker.body.deviceSecret

    const NUL = String.fromCharCode(0)
    const nearMisses = [
      'Sup3rSecret',
      'sup3rSecret!',
      'SUP3RSECRET!',
      NUL + 'Sup3rSecret!',
      'Sup3rSecret!' + NUL + 'junk',
      'Sup3rSecret! '
    ]
    for (const candidate of nearMisses) {
      const bad = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '462001', password: candidate, deviceSecret: secret }
      })
      expect(bad.status, `近似密码 ${JSON.stringify(candidate)} 不得进房`).toBe(401)
      expect(bad.body.error.code, `近似密码 ${JSON.stringify(candidate)} 应判 wrong-password`).toBe('wrong-password')
    }

    // 正确密码仍能进（前几次失败没误锁、也没误放行过）
    const good = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '462001', password: 'Sup3rSecret!', deviceSecret: secret }
    })
    expect(good.status).toBe(200)
  })

  it('尾随 \\u0000 是隐形字符：密码后拼 NUL 也能进房，比对不是精确匹配', async () => {
    const h = await createSecurityHarness()
    const ownerReg = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Owner' } })
    await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${ownerReg.body.deviceSecret}`,
      body: { roomId: '462004', password: 'Sup3rSecret!' }
    })
    const attacker = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Probe' } })
    const secret: string = attacker.body.deviceSecret

    // Node 的 scrypt 会剥掉密码末尾的全部 NUL 字节（嵌入 NUL 不受影响），
    // 于是「密码 + 尾随 \u0000」与密码本身哈希相同——两个不同的字符串开了同一扇门。
    // 契约要求密码比对失败必须 wrong-password：比对应当精确到整个字符串。
    const NUL = String.fromCharCode(0)
    const aliased = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '462004', password: 'Sup3rSecret!' + NUL, deviceSecret: secret }
    })
    expect(
      aliased.status,
      `'Sup3rSecret!\\u0000' 与 'Sup3rSecret!' 是不同字符串，不得进房（实测 ${aliased.status} ${aliased.body?.error?.code ?? '成功进入'}）；` +
      'scrypt 对 string/Buffer 输入剥掉尾随 NUL，比对不再精确'
    ).toBe(401)
  })

  it('REST 密码类型混淆：数字/数组/对象/null/空串/超长串一律 400 invalid-password 且不产生成员', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '462002', PASSWORD)
    const attacker = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Probe' } })
    const secret: string = attacker.body.deviceSecret

    const garbage: Array<{ label: string; password: unknown }> = [
      { label: '数字', password: 123456 },
      { label: '数组', password: [PASSWORD] },
      { label: '对象', password: { password: PASSWORD } },
      { label: 'null', password: null },
      { label: '空串', password: '' },
      { label: '超长串', password: 'a'.repeat(129) }
    ]
    for (const { label, password } of garbage) {
      const bad = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '462002', password, deviceSecret: secret }
      })
      expect(bad.status, `${label}密码必须 400`).toBe(400)
      expect(bad.body.error.code, `${label}密码应判 invalid-password`).toBe('invalid-password')
    }

    // 垃圾输入一个都没进去：正确密码进房后成员恰好 2 人（房主 + 攻击者）
    const good = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '462002', password: PASSWORD, deviceSecret: secret }
    })
    expect(good.status).toBe(200)
    const listed = await httpJson(h, 'GET', '/rooms/462002/members', { authorization: `Bearer ${good.body.ticket.ticket}` })
    expect(listed.body.members).toHaveLength(2)
  })

  it('WS 密码类型混淆：非字符串密码建房/进房都被拒，房间不会被创建出来', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '462003', PASSWORD)
    const attacker = await connectDevice(h, 'Probe')

    const badCreate = await rpc(attacker.client, 'room-create', { roomId: '462099', password: 123456 }, 'create-num')
    expect(badCreate.type, '数字密码建房必须被拒').toBe('error')
    expect((badCreate.payload as { code: string }).code).toBe('invalid-password')

    const badJoinArr = await rpc(attacker.client, 'room-join', { roomId: '462003', password: [PASSWORD] }, 'join-arr')
    expect(badJoinArr.type).toBe('error')
    expect((badJoinArr.payload as { code: string }).code).toBe('invalid-password')

    const badJoinNull = await rpc(attacker.client, 'room-join', { roomId: '462003', password: null }, 'join-null')
    expect(badJoinNull.type).toBe('error')
    expect((badJoinNull.payload as { code: string }).code).toBe('invalid-password')

    // 被拒的建房不能留下房间：462099 必须不存在
    const probe = await rpc(attacker.client, 'room-join', { roomId: '462099', password: PASSWORD }, 'join-ghost')
    expect(probe.type, '类型混淆的建房不得留下可用房间').toBe('error')
    expect((probe.payload as { code: string }).code).toBe('room-not-found')
  })
})

// ---------------------------------------------------------------------------
// 票据
// ---------------------------------------------------------------------------

describe('票据', () => {
  it('拿 A 房的票据访问 B 房成员接口与聊天历史被拒（票据跨房间复用）', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463001', PASSWORD)
    await createRoomViaWs(owner, '463002', PASSWORD)
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '463001', PASSWORD)
    const ticket: string = joined.ticket.ticket

    const crossMembers = await httpJson(h, 'GET', '/rooms/463002/members', { authorization: `Bearer ${ticket}` })
    expect(crossMembers.status, 'A 房票据读 B 房成员必须 401').toBe(401)
    expect(crossMembers.body.error.code).toBe('invalid-ticket')
    expect(crossMembers.body.members).toBeUndefined()

    const crossHistory = await httpJson(h, 'GET', '/chat/history?roomId=463002', { authorization: `Bearer ${ticket}` })
    expect(crossHistory.status, 'A 房票据读 B 房历史必须 401').toBe(401)
    expect(crossHistory.body.error.code).toBe('invalid-ticket')

    // 对照：本房票据照常可用
    const own = await httpJson(h, 'GET', '/chat/history?roomId=463001', { authorization: `Bearer ${ticket}` })
    expect(own.status).toBe(200)
  })

  it('伪造的随机 hex 票据被拒', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463003', PASSWORD)

    const forged = await httpJson(h, 'GET', '/rooms/463003/members', {
      authorization: `Bearer ${'f'.repeat(64)}`
    })
    expect(forged.status, '伪造票据必须 401').toBe(401)
    expect(forged.body.error.code).toBe('invalid-ticket')
    expect(forged.body.members).toBeUndefined()
  })

  it('过期票据被拒', async () => {
    const h = await createSecurityHarness({ ticketTtlMs: 400 })
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463004', PASSWORD)
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '463004', PASSWORD)
    const ticket = joined.ticket

    await until(() => Date.now() >= ticket.expiresAt + 20)
    const expired = await httpJson(h, 'GET', '/rooms/463004/members', {
      authorization: `Bearer ${ticket.ticket}`
    })
    expect(expired.status, '过期票据必须 401').toBe(401)
    expect(expired.body.error.code).toBe('invalid-ticket')
  })

  it('被踢之后：旧票据作废、会话被摘除、错密码免密回房被拒、房间广播收不到', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463005', PASSWORD)
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '463005', PASSWORD)
    const ticket: string = joined.ticket.ticket

    // 房主从 user-joined 推送拿到真实 deviceId 后踢人
    const notice = await waitForAny(owner.client, m => m.type === 'user-joined')
    const kicked = await rpc(owner.client, 'room-kick', { roomId: '463005', deviceId: (notice.payload as any).deviceId }, 'kick')
    expect(kicked.type).toBe('room-member-kicked')

    const stale = await httpJson(h, 'GET', '/rooms/463005/members', { authorization: `Bearer ${ticket}` })
    expect(stale.status, '被踢者的旧票据必须作废').toBe(401)
    expect(stale.body.error.code).toBe('invalid-ticket')

    // 会话被摘除：chat-message 被拒；错密码的 room-join 也不能借快速通道回房
    const chat = await rpc(member.client, 'chat-message', { roomId: '463005', content: '我还在吗' }, 'chat-after-kick')
    expect(chat.type).toBe('error')
    expect((chat.payload as { code: string }).code).toBe('not-a-member')

    const rejoin = await rpc(member.client, 'room-join', { roomId: '463005', password: WRONG_PASSWORD }, 'rejoin-after-kick')
    expect(rejoin.type, '被踢者错密码不得借快速通道回房').toBe('error')
    expect((rejoin.payload as { code: string }).code).toBe('wrong-password')

    owner.client.send({ type: 'chat-message', payload: { roomId: '463005', content: '内部消息' }, messageId: 'seed' })
    await owner.client.waitFor(m => m.type === 'chat-message-ack')
    await expectSilence(member.client, m => m.type === 'chat-message')
  })

  it('关房之后：旧票据作废、旧房号进不去（room-closed）', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463006', PASSWORD)
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '463006', PASSWORD)
    const ticket: string = joined.ticket.ticket

    const closed = await rpc(owner.client, 'room-close', { roomId: '463006' }, 'close')
    expect(closed.type).toBe('room-closed')

    const stale = await httpJson(h, 'GET', '/rooms/463006/members', { authorization: `Bearer ${ticket}` })
    expect(stale.status, '关房后旧票据必须作废').toBe(401)
    expect(stale.body.error.code).toBe('invalid-ticket')

    const newcomer = await connectDevice(h, 'Newcomer')
    const late = await rpc(newcomer.client, 'room-join', { roomId: '463006', password: PASSWORD }, 'late')
    expect(late.type).toBe('error')
    expect((late.payload as { code: string }).code).toBe('room-closed')
  })

  it('改密码之后：旧密码进不了房、旧票据作废、新密码才能进', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463007', PASSWORD)
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '463007', PASSWORD)
    const oldTicket: string = joined.ticket.ticket

    const changed = await rpc(owner.client, 'room-password', { roomId: '463007', password: 'brand-new-pw' }, 'chpw')
    expect(changed.type).toBe('room-password-changed')

    const stale = await httpJson(h, 'GET', '/rooms/463007/members', { authorization: `Bearer ${oldTicket}` })
    expect(stale.status, '改密后旧票据必须作废').toBe(401)
    expect(stale.body.error.code).toBe('invalid-ticket')

    const outsider = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Outsider' } })
    const oldPw = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '463007', password: PASSWORD, deviceSecret: outsider.body.deviceSecret }
    })
    expect(oldPw.status, '旧密码必须进不了房').toBe(401)
    expect(oldPw.body.error.code).toBe('wrong-password')

    const newPw = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '463007', password: 'brand-new-pw', deviceSecret: outsider.body.deviceSecret }
    })
    expect(newPw.status, '新密码必须能进房').toBe(200)
  })

  it('拿房间票据当 deviceSecret 去建房被拒，目标房号也不会被占下', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '463008', PASSWORD)
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '463008', PASSWORD)

    const hijack = await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${joined.ticket.ticket}`,
      body: { roomId: '463808', password: 'attacker-pw' }
    })
    expect(hijack.status, '票据不能当 deviceSecret 用').toBe(401)
    expect(hijack.body.error.code).toBe('invalid-ticket')

    // 房号没被占下：正常设备仍可用它建房
    const fresh = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Fresh' } })
    const ok = await httpJson(h, 'POST', '/rooms/create', {
      authorization: `Bearer ${fresh.body.deviceSecret}`,
      body: { roomId: '463808', password: 'normal-pw-1' }
    })
    expect(ok.status, '被拒的建房不得留下占位').toBe(200)
  })
})

// ---------------------------------------------------------------------------
// WS 前门与身份
// ---------------------------------------------------------------------------

describe('WS 前门与身份', () => {
  it('无 token 的 WS 连接被拒（close 4001），拿不到 welcome', async () => {
    const h = await createSecurityHarness()
    const client = await TestClient.open(h, { deviceId: '0badcafe0badcafe', deviceName: 'NoToken' })
    const close = await Promise.race([
      client.closed,
      sleep(2000).then(() => ({ code: -1, reason: 'timeout' }))
    ])
    expect(close.code, '无 token 连接必须被 4001 关闭').toBe(4001)
    expect(client.received('welcome'), '被拒连接不得拿到 welcome').toBe(false)
  })

  it('自报从未登记的 deviceId 能连上 WS，但建房/进房被 invalid-device 挡住', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '464001', PASSWORD)

    // 攻击者不登记设备，直接自报一个编造的 deviceId 换 legacy token
    const forged = await httpJson(h, 'POST', '/token', { body: { deviceId: 'deadbeefdeadbeef' } })
    if (forged.status !== 200 || typeof forged.body?.token !== 'string') {
      return // legacy 回落已关闭：这条链走不通，门禁成立
    }
    const impostor = await TestClient.open(h, { deviceId: 'deadbeefdeadbeef', token: forged.body.token, deviceName: 'Impostor' })
    try {
      await impostor.waitFor(m => m.type === 'welcome')
    } catch {
      return // 连接被拒：门禁成立
    }

    const join = await rpc(impostor, 'room-join', { roomId: '464001', password: WRONG_PASSWORD }, 'ghost-join')
    expect(join.type, '从未登记的自报 deviceId 不得进房').toBe('error')
    expect((join.payload as { code: string }).code).toBe('invalid-device')

    const create = await rpc(impostor, 'room-create', { roomId: '464099', password: PASSWORD }, 'ghost-create')
    expect(create.type, '从未登记的自报 deviceId 不得建房').toBe('error')
    expect((create.payload as { code: string }).code).toBe('invalid-device')
  })
})

// ---------------------------------------------------------------------------
// 冒充攻击：legacy /token × 成员快速通道
// ---------------------------------------------------------------------------

describe('冒充攻击（legacy /token × 成员快速通道）', () => {
  it('用 legacy /token 冒充已登记成员：错密码走快速通道免密进房并读到房间聊天', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    const victim = await connectDevice(h, 'Victim')
    await createRoomViaWs(owner, '465001', PASSWORD)
    await joinRoomViaWs(victim, '465001', PASSWORD)
    owner.client.send({ type: 'chat-message', payload: { roomId: '465001', content: SECRET_MESSAGE }, messageId: 'seed' })
    await owner.client.waitFor(m => m.type === 'chat-message-ack')

    // 攻击者零凭据：自报受害者的 deviceId 换 legacy token
    const forged = await httpJson(h, 'POST', '/token', { body: { deviceId: victim.deviceId } })
    if (forged.status !== 200 || typeof forged.body?.token !== 'string') {
      return // legacy 回落已关闭：门禁成立
    }
    let impostor: TestClient
    try {
      impostor = await TestClient.open(h, { deviceId: victim.deviceId, token: forged.body.token, deviceName: 'Impostor' })
      await impostor.waitFor(m => m.type === 'welcome')
    } catch {
      return // 连接被拒：门禁成立
    }

    // 冒充会话用错密码请求进房：契约要求拒绝（§1.8 没有任何路径允许「自称 deviceId 即视作成员」）
    const reply = await rpc(impostor, 'room-join', { roomId: '465001', password: WRONG_PASSWORD }, 'spoof-join')
    if (reply.type !== 'room-joined') {
      expect(reply.type, '冒充会话应被拒绝').toBe('error')
      return
    }

    // 走到这里说明洞存在：继续取证——冒充会话能否读到房间内容
    const hist = await rpc(impostor, 'chat-history-request', { roomId: '465001' }, 'spoof-hist')
    const messages = Array.isArray((hist.payload as any)?.messages) ? (hist.payload as any).messages : []
    const gotSecret = messages.some((m: any) => m.content === SECRET_MESSAGE)
    const ticket = (reply.payload as RoomJoinResult).ticket
    expect(
      reply.type,
      `冒充会话用错密码免密进了房（room-join→room-joined，票据 role=${ticket?.role}），` +
      `chat-history→${hist.type}（读到 ${messages.length} 条，含房主私信=${gotSecret}）。` +
      '冻结契约 §1.8：没有任何路径允许「自称 deviceId 即视作成员」'
    ).toBe('error')
  })

  it('被踢 + 锁房 + 错密码：冒充在房成员把三重防线一起绕过', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '465002', PASSWORD)
    const member = await connectDevice(h, 'Member')
    await joinRoomViaWs(member, '465002', PASSWORD)
    const attacker = await connectDevice(h, 'Attacker')
    await joinRoomViaWs(attacker, '465002', PASSWORD)

    // 房主踢掉攻击者并锁房
    const kickNotice = await waitForAny(owner.client, m => m.type === 'user-joined' && (m.payload as any).deviceId === attacker.deviceId)
    expect(kickNotice.type).toBe('user-joined')
    const kicked = await rpc(owner.client, 'room-kick', { roomId: '465002', deviceId: attacker.deviceId }, 'kick')
    expect(kicked.type).toBe('room-member-kicked')
    const locked = await rpc(owner.client, 'room-lock', { roomId: '465002', locked: true }, 'lock')
    expect(locked.type).toBe('room-locked')

    // 防线自检：被踢者自己拿正确密码也进不去（锁定对非成员生效）
    const own = await rpc(attacker.client, 'room-join', { roomId: '465002', password: PASSWORD }, 'own-rejoin')
    expect(own.type, '被踢+锁房后，本人持正确密码也必须被拒').toBe('error')
    expect((own.payload as { code: string }).code).toBe('room-locked')

    // 攻击者冒充仍在房内的 member：legacy token + 错密码
    const forged = await httpJson(h, 'POST', '/token', { body: { deviceId: member.deviceId } })
    if (forged.status !== 200 || typeof forged.body?.token !== 'string') {
      return // legacy 回落已关闭：门禁成立
    }
    let impostor: TestClient
    try {
      impostor = await TestClient.open(h, { deviceId: member.deviceId, token: forged.body.token, deviceName: 'Impostor' })
      await impostor.waitFor(m => m.type === 'welcome')
    } catch {
      return // 连接被拒：门禁成立
    }

    const reply = await rpc(impostor, 'room-join', { roomId: '465002', password: WRONG_PASSWORD }, 'spoof-rejoin')
    expect(
      reply.type,
      `被踢+锁房+错密码三重防线下，冒充在房成员的会话仍免密进了房（→${reply.type}）：` +
      '快速通道既不校验凭据归属，也不检查 locked'
    ).toBe('error')
  })

  it('冒充房主改掉房间密码：零知识链 = 房间列表脱敏 id × 设备列表真 id 反查', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '465003', PASSWORD)

    // 零知识定位房主：房间列表给脱敏 id，设备列表给真 id，mask 撞一下就反查出来了
    const list = await httpJson(h, 'GET', '/rooms')
    const room = (list.body?.rooms ?? []).find((r: any) => r.roomId === '465003')
    expect(room).toBeTruthy()
    const devices = await httpJson(h, 'GET', '/devices')
    const ownerRealId = (devices.body?.devices ?? [])
      .map((d: any) => d.deviceId as string)
      .find(id => maskDeviceId(id) === room.ownerDeviceId)
    if (!ownerRealId) {
      return // 反查不可行：这条链走不通，门禁成立
    }

    const forged = await httpJson(h, 'POST', '/token', { body: { deviceId: ownerRealId } })
    if (forged.status !== 200 || typeof forged.body?.token !== 'string') {
      return // legacy 回落已关闭：门禁成立
    }
    let impostor: TestClient
    try {
      impostor = await TestClient.open(h, { deviceId: ownerRealId, token: forged.body.token, deviceName: 'Impostor' })
      await impostor.waitFor(m => m.type === 'welcome')
    } catch {
      return // 连接被拒：门禁成立
    }

    const reply = await rpc(impostor, 'room-password', { roomId: '465003', password: 'hijacked-pw' }, 'hijack')
    if (reply.type !== 'room-password-changed') {
      expect(reply.type, '冒充会话不得改房间密码').toBe('error')
      return
    }

    // 取证：原密码对新设备已失效 = 接管是真的
    const fresh = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Fresh' } })
    const impact = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '465003', password: PASSWORD, deviceSecret: fresh.body.deviceSecret }
    })
    expect(
      reply.type,
      `冒充房主改掉了房间密码（room-password→${reply.type}），原密码对新设备已失效（join→${impact.status}）。` +
      '冻结契约 §1.8：没有任何路径允许「自称 deviceId 即视作成员」'
    ).toBe('error')
  })

  it('同一 deviceId 的新会话未经 room-join 挂载时读不了成员与历史（会话级隔离仍成立）', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '465004', PASSWORD)
    const member = await connectDevice(h, 'Member')
    await joinRoomViaWs(member, '465004', PASSWORD)

    // 同 deviceId 的第二个会话：没走 room-join 就直接要成员列表/历史
    const forged = await httpJson(h, 'POST', '/token', { body: { deviceId: member.deviceId } })
    if (forged.status !== 200 || typeof forged.body?.token !== 'string') {
      return // legacy 回落已关闭：门禁成立
    }
    let impostor: TestClient
    try {
      impostor = await TestClient.open(h, { deviceId: member.deviceId, token: forged.body.token, deviceName: 'Impostor' })
      await impostor.waitFor(m => m.type === 'welcome')
    } catch {
      return
    }

    const members = await rpc(impostor, 'room-members', { roomId: '465004' }, 'ghost-members')
    expect(members.type, '未挂载的新会话不得读成员列表').toBe('error')
    expect((members.payload as { code: string }).code).toBe('not-a-member')

    const hist = await rpc(impostor, 'chat-history-request', { roomId: '465004' }, 'ghost-hist')
    expect(hist.type, '未挂载的新会话不得读聊天历史').toBe('error')
    expect((hist.payload as { code: string }).code).toBe('not-a-member')
  })
})

// ---------------------------------------------------------------------------
// 限流重置
// ---------------------------------------------------------------------------

describe('限流重置', () => {
  it('成员快速通道进房清掉同 IP 的爆破锁定，换新设备可继续无限试错', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '466001', PASSWORD)

    // 攻击者先以旧密码正常进房成为成员；房主随即改密，把成员锁在门外
    const member = await connectDevice(h, 'Member')
    await joinRoomViaWs(member, '466001', PASSWORD)
    const changed = await rpc(owner.client, 'room-password', { roomId: '466001', password: 'brand-new-pw' }, 'chpw')
    expect(changed.type).toBe('room-password-changed')

    // 攻击者的另一台设备 brute force 新密码：8 次后触发锁定
    const brute = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Brute' } })
    const bruteSecret: string = brute.body.deviceSecret
    for (let i = 1; i <= 8; i++) {
      const bad = await httpJson(h, 'POST', '/rooms/join', {
        body: { roomId: '466001', password: `${WRONG_PASSWORD}-${i}`, deviceSecret: bruteSecret }
      })
      expect(bad.status, `第 ${i} 次错密码应 401`).toBe(401)
    }
    const locked = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '466001', password: WRONG_PASSWORD, deviceSecret: bruteSecret }
    })
    expect(locked.status, '第 9 次必须被锁定挡住').toBe(429)

    // 攻击者用仍持有席位的成员设备走快速通道进房（不需要密码）——这一步同时清了失败计数
    const rejoin = await rpc(member.client, 'room-join', { roomId: '466001', password: 'brand-new-pw' }, 'fast-rejoin')
    expect(rejoin.type, '在房成员快速通道回房本身是契约允许的').toBe('room-joined')

    // 锁定应当继续挡住同 IP 的新设备；若被清掉，爆破就能无限续杯
    const fresh = await httpJson(h, 'POST', '/devices/register', { body: { deviceName: 'Brute-2' } })
    const resumed = await httpJson(h, 'POST', '/rooms/join', {
      body: { roomId: '466001', password: WRONG_PASSWORD, deviceSecret: fresh.body.deviceSecret }
    })
    expect(
      resumed.status,
      `成员快速通道进房后，同 IP 的爆破锁定被清掉了（新设备错密码→${resumed.status} ${resumed.body?.error?.code}），` +
      '锁定期间该 IP 对该房的新尝试应继续被 429 挡住'
    ).toBe(429)
  })
})

// ---------------------------------------------------------------------------
// 信息泄漏
// ---------------------------------------------------------------------------

describe('信息泄漏', () => {
  it('房间列表/详情不漏密码哈希、salt、票据与真实房主设备标识；不可发现房间不出现', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '467001', PASSWORD)
    await createRoomViaWs(owner, '467002', PASSWORD, { discoverable: false })
    const member = await connectDevice(h, 'Member')
    const joined = await joinRoomViaWs(member, '467001', PASSWORD)
    const ticket: string = joined.ticket.ticket

    const list = await httpJson(h, 'GET', '/rooms')
    expect(list.status).toBe(200)
    const rooms = list.body.rooms
    expect(rooms.some((r: any) => r.roomId === '467002'), '不可发现的房间不得出现在公开列表').toBe(false)
    const serialized = JSON.stringify(rooms)
    expect(serialized).not.toContain(PASSWORD)
    expect(serialized).not.toContain('scrypt')
    expect(serialized).not.toContain('passwordHash')
    expect(serialized).not.toContain('deviceSecret')
    expect(serialized).not.toContain(ticket)
    expect(serialized).not.toContain(owner.deviceId)
    for (const r of rooms) {
      expect(r.ownerDeviceId, '公开投影的房主 id 必须是脱敏值').not.toBe(owner.deviceId)
      expect(r.ownerDeviceId).toMatch(/^[0-9a-f]{4}…[0-9a-f]{4}$/)
    }

    const detail = await httpJson(h, 'GET', '/rooms/467001', { authorization: `Bearer ${ticket}` })
    expect(detail.status).toBe(200)
    const detailText = JSON.stringify(detail.body)
    expect(detailText).not.toContain('scrypt')
    expect(detailText).not.toContain('passwordHash')
    expect(detailText).not.toContain(ticket)
    expect(detailText).not.toContain(owner.deviceId)
    expect(detail.body.room.ownerDeviceId).not.toBe(owner.deviceId)

    // WS 面的房间列表同样干净
    const wsList = await rpc(member.client, 'room-list', {}, 'ws-list')
    expect(wsList.type).toBe('room-list')
    const wsText = JSON.stringify(wsList.payload)
    expect(wsText).not.toContain('scrypt')
    expect(wsText).not.toContain(ticket)
    expect(wsText).not.toContain(owner.deviceId)
  })

  it('非房主成员看到的成员 deviceId 全是脱敏值', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '467003', PASSWORD)
    const member = await connectDevice(h, 'Member')
    await joinRoomViaWs(member, '467003', PASSWORD)

    const listed = await rpc(member.client, 'room-members', { roomId: '467003' }, 'members')
    expect(listed.type).toBe('room-members')
    const members = (listed.payload as { members: Array<{ deviceId: string }> }).members
    for (const m of members) {
      expect(m.deviceId, `成员视图的 deviceId 必须脱敏，实测 ${m.deviceId}`).toMatch(/^(\*\*\*|[0-9a-f]{4}…[0-9a-f]{4})$/)
      expect(m.deviceId).not.toBe(owner.deviceId)
      expect(m.deviceId).not.toBe(member.deviceId)
    }
  })

  it('房主视角的成员列表按冻结契约也应脱敏（§1.1 成员视图 deviceId 一律脱敏）', async () => {
    const h = await createSecurityHarness()
    const owner = await connectDevice(h, 'Owner')
    await createRoomViaWs(owner, '467004', PASSWORD)
    const member = await connectDevice(h, 'Member')
    await joinRoomViaWs(member, '467004', PASSWORD)

    const listed = await rpc(owner.client, 'room-members', { roomId: '467004' }, 'owner-members')
    expect(listed.type).toBe('room-members')
    const members = (listed.payload as { members: Array<{ deviceId: string }> }).members
    const leaked = members.filter(m => m.deviceId === owner.deviceId || m.deviceId === member.deviceId)
    expect(
      leaked,
      `冻结契约 §1.1「成员视图。deviceId 同样脱敏」不分视角：房主响应里出现了 ${leaked.map(m => m.deviceId).join(',')}。` +
      '（真实 id 应当只经 user-joined 等推送语义流转，成员列表一律脱敏）'
    ).toHaveLength(0)
  })
})
