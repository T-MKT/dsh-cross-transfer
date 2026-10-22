/**
 * 房间 Git 工作区同步：WS + REST 端到端验收（冻结契约 §6.2）。
 *
 * 范围（每一条都是验收项）：
 * - WS：房主 room-git-config 成功；成员调配置 → forbidden；成员绑定后 room-git-status
 *   广播到同房其它成员（且工作区路径只对本人与房主可见）；成员 room-git-sync 返回
 *   room-git-sync-result；不同房间互不可见。
 * - REST：7 条新路由（GET/PUT/DELETE /rooms/:roomId/git、PUT/DELETE
 *   /rooms/:roomId/workspace、POST /rooms/:roomId/git/sync、GET
 *   /rooms/:roomId/workspaces）的成功路径，以及 401（缺票据）/403（非房主）/405（方法不匹配）。
 * - 建房带 repo：非法 URL 先校验、不建房；合法 repo 建房后 RoomInfo.repoConfigured 为 true。
 * - 房间列表/详情投影只含 repoConfigured 布尔值，绝不含 URL/token。
 * - 房间内被踢/退房后该成员的绑定被清掉。
 *
 * 接线方式与 test/rooms.e2e.test.ts 一致：ctx.provide('webServer', fake) + apply(ctx, {...})
 * + 自建 http server 派发 prefix/upgrade 路由 + httpJson + TestClient；断言只看线上行为
 * （WS 帧 + HTTP 状态码），不回查服务内部状态。roomGit 用极小的 debounceMs/pushTimeoutMs，
 * 避免测试等待；push 一律关掉（autoPush:false），不触网。
 *
 * 跑法：node node_modules/vitest/vitest.mjs --run test/room-workspace.e2e.test.ts
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server as HTTPServer, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import type { Duplex } from 'stream'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WebSocket } from 'ws'
import { apply } from '../src/index.js'
import { DEFAULT_ROOM_CONFIG, maskDeviceId, type RoomJoinResult } from '../src/rooms.js'
import type { WSMessage } from '../src/ws-server.js'
import type { RoomRepoConfigInput, RoomRepoStatus, SyncSummary, WorkspaceBindingStatus } from '../src/room-workspace.js'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 插件挂载路径与 tokenSecret：apply 的配置与 token 计算共用这两个常量。 */
const MOUNT_PATH = '/api/cross-transfer'
const TOKEN_SECRET = 'room-workspace-e2e-token'
const PASSWORD = 'e2e-pass-123'

/**
 * roomGit 测试配置（契约 §4.6）：debounceMs/pushTimeoutMs 取极小值，
 * 其余保持默认。整块是 RoomGitConfig（schemastery 会把缺省补全）。
 */
const ROOM_GIT_TEST_CONFIG = {
  enabled: true,
  debounceMs: 1,
  pushTimeoutMs: 1000,
  maxBindingsPerRoom: 16,
  maxCandidates: 50
}

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
  disposers: Array<() => void>
}

const harnesses: E2EHarness[] = []

/** 真实临时目录：绑定走 fs.stat/realpath，必须落在磁盘上。 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-workspace-e2e-'))
let wsCounter = 0

/** 每个用例一个独立工作区目录，避免绑定串味。 */
function nextWorkspaceDir(prefix = 'ws'): string {
  wsCounter += 1
  const dir = path.join(tmpRoot, `${prefix}-${wsCounter}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 夹具配方：宿主半加载的前提是一个 webServer 服务。fake 只记录路由登记，
 * 真正的请求由测试自己起的 http server 转交 —— 这样 apply() 的全部宿主接线
 * （路由注册、effect 托管、服务构造顺序）都原样跑到。
 */
async function createE2eHarness(): Promise<E2EHarness> {
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
    rooms: { ...DEFAULT_ROOM_CONFIG },
    roomGit: ROOM_GIT_TEST_CONFIG
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

interface HttpResult {
  status: number
  body: any
}

async function httpJson(
  h: E2EHarness,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
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
  deviceName: string
  ticket?: string
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
    deviceName,
    ticket: undefined
  }
}

let rpcSeq = 0

/** 发送带 messageId 的请求帧，等待同 messageId 的应答（成功帧或 error 帧）。 */
async function rpc(client: TestClient, type: string, payload: unknown, messageId: string): Promise<WSMessage> {
  client.send({ type, payload, messageId })
  return client.waitFor(m => m.messageId === messageId, 8000)
}

async function createRoomViaWs(
  owner: Member,
  roomId: string,
  password: string,
  repo?: RoomRepoConfigInput
): Promise<RoomJoinResult> {
  const payload: Record<string, unknown> = { password, name: '验收房', roomId }
  if (repo) payload.repo = repo
  const reply = await rpc(owner.client, 'room-create', payload, `create-${roomId}-${++rpcSeq}`)
  expect(reply.type).toBe('room-created')
  const result = reply.payload as RoomJoinResult
  owner.ticket = result.ticket.ticket
  return result
}

async function joinRoomViaWs(member: Member, roomId: string, password: string): Promise<RoomJoinResult> {
  const reply = await rpc(member.client, 'room-join', { roomId, password }, `join-${roomId}-${++rpcSeq}`)
  expect(reply.type).toBe('room-joined')
  const result = reply.payload as RoomJoinResult
  member.ticket = result.ticket.ticket
  return result
}

/** 配好仓库 + 成员已绑定的标准房间，REST/WS 用例的公共前置。 */
async function setupBoundRoom(h: E2EHarness, roomId: string): Promise<{ owner: Member; member: Member; dir: string }> {
  const owner = await connectDevice(h, `Owner-${roomId}`)
  const member = await connectDevice(h, `Member-${roomId}`)
  await createRoomViaWs(owner, roomId, PASSWORD)
  await joinRoomViaWs(member, roomId, PASSWORD)
  await rpc(owner.client, 'room-git-config', {
    roomId,
    repo: { remoteUrl: `https://example.com/team/${roomId}.git`, autoPush: false }
  }, `cfg-${roomId}-${++rpcSeq}`)
  const dir = nextWorkspaceDir(`ws-${roomId}`)
  await rpc(member.client, 'room-workspace-bind', { roomId, path: dir }, `bind-${roomId}-${++rpcSeq}`)
  return { owner, member, dir }
}

/** 按脱敏 id 取某个成员在状态投影里的绑定行。 */
function bindingRow(status: RoomRepoStatus, deviceId: string): WorkspaceBindingStatus | undefined {
  return status.bindings.find(b => b.deviceId === maskDeviceId(deviceId))
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

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// WS 面
// ---------------------------------------------------------------------------

describe('房间 Git 工作区同步端到端（真实 apply 接线）', () => {
  describe('WS 面', () => {
    it('验收1 房主 room-git-config 成功：返回脱敏状态，token 与未剥离 URL 一律不外流', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      await createRoomViaWs(owner, '410001', PASSWORD)

      const reply = await rpc(owner.client, 'room-git-config', {
        roomId: '410001',
        repo: {
          remoteUrl: 'https://example.com/team/repo.git',
          branch: 'main',
          auth: { type: 'token', token: 'super-secret-token' }
        }
      }, 'git-config-1')

      expect(reply.type).toBe('room-git-status')
      const status = reply.payload as RoomRepoStatus
      expect(status.roomId).toBe('410001')
      expect(status.configured).toBe(true)
      expect(status.remoteUrl).toBe('https://example.com/team/repo.git')
      expect(status.branch).toBe('main')
      expect(status.authConfigured).toBe(true)
      expect(status.autoCommit).toBe(true)
      expect(status.autoPush).toBe(true)
      // 房主自己还没绑定：成员行在、bound=false
      expect(status.bindings).toHaveLength(1)
      expect(status.bindings[0].bound).toBe(false)

      const serialized = JSON.stringify(status)
      expect(serialized).not.toContain('super-secret-token')
      expect(serialized).not.toContain('password')
    })

    it('验收2 成员调配置 → forbidden（服务层 isOwner 判定，不是门禁拦的）', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      await createRoomViaWs(owner, '410002', PASSWORD)
      await joinRoomViaWs(member, '410002', PASSWORD)

      const reply = await rpc(member.client, 'room-git-config', {
        roomId: '410002',
        repo: { remoteUrl: 'https://example.com/team/x.git' }
      }, 'git-config-member')

      expect(reply.type).toBe('error')
      expect(reply.messageId).toBe('git-config-member')
      expect((reply.payload as { code: string }).code).toBe('forbidden')
    })

    it('验收3 成员绑定 → room-git-status 广播到同房其它成员，且路径只对本人与房主可见', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      const other = await connectDevice(h, 'Other')
      await createRoomViaWs(owner, '410003', PASSWORD)
      await joinRoomViaWs(member, '410003', PASSWORD)
      await joinRoomViaWs(other, '410003', PASSWORD)
      await rpc(owner.client, 'room-git-config', {
        roomId: '410003',
        repo: { remoteUrl: 'https://example.com/team/r3.git', autoPush: false }
      }, 'cfg-3')

      const dir = nextWorkspaceDir('ws3')
      const bindReply = await rpc(member.client, 'room-workspace-bind', { roomId: '410003', path: dir }, 'bind-3')
      expect(bindReply.type).toBe('room-git-status')
      const own = bindReply.payload as RoomRepoStatus
      const ownRow = bindingRow(own, member.deviceId)
      expect(ownRow?.bound).toBe(true)
      expect(ownRow?.repoReady).toBe(true)
      // 绑定者本人看得到自己的真实路径
      expect(ownRow?.workspacePath).toBe(fs.realpathSync.native(dir))

      const realPath = fs.realpathSync.native(dir)
      // 房主收到广播：房主视角拿得到路径
      const ownerBroadcast = await waitForAny(
        owner.client,
        m => m.type === 'room-git-status' && m.messageId === undefined &&
          (m.payload as RoomRepoStatus).bindings.some(b => b.deviceId === maskDeviceId(member.deviceId) && b.bound)
      )
      expect(bindingRow(ownerBroadcast.payload as RoomRepoStatus, member.deviceId)?.workspacePath).toBe(realPath)

      // 同房其它成员收到同一事件，但看不到别人的宿主目录
      const otherBroadcast = await waitForAny(
        other.client,
        m => m.type === 'room-git-status' && m.messageId === undefined &&
          (m.payload as RoomRepoStatus).bindings.some(b => b.deviceId === maskDeviceId(member.deviceId) && b.bound)
      )
      const otherRow = bindingRow(otherBroadcast.payload as RoomRepoStatus, member.deviceId)
      expect(otherRow?.bound).toBe(true)
      expect(otherRow?.workspacePath).toBeUndefined()
    })

    it('验收4 成员 room-git-sync 返回 room-git-sync-result，并把结果广播给同房成员', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      await createRoomViaWs(owner, '410004', PASSWORD)
      await joinRoomViaWs(member, '410004', PASSWORD)
      await rpc(owner.client, 'room-git-config', {
        roomId: '410004',
        repo: { remoteUrl: 'https://example.com/team/r4.git', autoPush: false }
      }, 'cfg-4')

      const dir = nextWorkspaceDir('ws4')
      await rpc(member.client, 'room-workspace-bind', { roomId: '410004', path: dir }, 'bind-4')
      fs.writeFileSync(path.join(dir, 'hello.txt'), 'hello')

      const reply = await rpc(member.client, 'room-git-sync', { roomId: '410004' }, 'sync-4')
      expect(reply.type).toBe('room-git-sync-result')
      const payload = reply.payload as { roomId: string; result: SyncSummary }
      expect(payload.roomId).toBe('410004')
      expect(payload.result.ok).toBe(true)
      expect(payload.result.committed).toBe(1)
      expect(payload.result.pushed).toBe(false)
      expect(payload.result.trigger).toBe('manual')
      expect(payload.result.commitOid).toMatch(/^[0-9a-f]{40}$/)

      const broadcast = await waitForAny(
        owner.client,
        m => m.type === 'room-git-sync-result' &&
          (m.payload as { deviceId: string }).deviceId === member.deviceId
      )
      expect((broadcast.payload as { result: SyncSummary }).result.committed).toBe(1)
    })

    it('验收5 不同房间互不可见：绑定与仓库细节不跨房间泄漏', async () => {
      const h = await createE2eHarness()
      // 房间 A
      const ownerA = await connectDevice(h, 'OwnerA')
      const memberA = await connectDevice(h, 'MemberA')
      await createRoomViaWs(ownerA, '410005', PASSWORD)
      await joinRoomViaWs(memberA, '410005', PASSWORD)
      await rpc(ownerA.client, 'room-git-config', {
        roomId: '410005',
        repo: { remoteUrl: 'https://example.com/team/a.git', autoPush: false }
      }, 'cfg-a')
      const dirA = nextWorkspaceDir('wsA')
      await rpc(memberA.client, 'room-workspace-bind', { roomId: '410005', path: dirA }, 'bind-a')

      // 房间 B
      const ownerB = await connectDevice(h, 'OwnerB')
      const memberB = await connectDevice(h, 'MemberB')
      await createRoomViaWs(ownerB, '410006', PASSWORD)
      await joinRoomViaWs(memberB, '410006', PASSWORD)
      await rpc(ownerB.client, 'room-git-config', {
        roomId: '410006',
        repo: { remoteUrl: 'https://example.com/team/b.git', autoPush: false }
      }, 'cfg-b')

      const statusB = await rpc(memberB.client, 'room-git-status', { roomId: '410006' }, 'st-b')
      const payloadB = statusB.payload as RoomRepoStatus
      // B 房视角里没有 A 房成员，也没有 A 房的宿主目录/仓库地址
      expect(payloadB.bindings.some(b => b.deviceId === maskDeviceId(memberA.deviceId))).toBe(false)
      expect(payloadB.bindings.some(b => b.deviceId === maskDeviceId(ownerA.deviceId))).toBe(false)
      const serializedB = JSON.stringify(payloadB)
      expect(serializedB).not.toContain(fs.realpathSync.native(dirA))
      expect(serializedB).not.toContain('a.git')

      const statusA = await rpc(memberA.client, 'room-git-status', { roomId: '410005' }, 'st-a')
      const payloadA = statusA.payload as RoomRepoStatus
      expect(payloadA.bindings.some(b => b.deviceId === maskDeviceId(memberB.deviceId))).toBe(false)
      expect(JSON.stringify(payloadA)).not.toContain('b.git')
    })

    it('验收6 建房带非法 repo：先校验、不建房（协议/分支/userinfo 与 auth 冲突三类）', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')

      const cases: Array<[string, RoomRepoConfigInput, string]> = [
        ['410007', { remoteUrl: 'ssh://git@github.com/x/y.git' }, 'create-bad-scheme'],
        ['410008', { remoteUrl: 'https://example.com/x.git', branch: '../evil' }, 'create-bad-branch'],
        ['410009', { remoteUrl: 'https://user:pass@github.com/x/y.git', auth: { type: 'token', token: 't' } }, 'create-bad-userinfo']
      ]
      for (const [roomId, repo, messageId] of cases) {
        const reply = await rpc(owner.client, 'room-create', { roomId, password: PASSWORD, name: 'X', repo }, messageId)
        expect(reply.type).toBe('error')
        expect((reply.payload as { code: string }).code).toBe('invalid-repo')
        // 校验失败必须落在建房之前：房间根本不存在
        const join = await rpc(owner.client, 'room-join', { roomId, password: PASSWORD }, `join-${roomId}`)
        expect(join.type).toBe('error')
        expect((join.payload as { code: string }).code).toBe('room-not-found')
      }
    })

    it('验收7 建房带合法 repo：建房成功且 RoomInfo.repoConfigured 为 true，内嵌 userinfo 被剥离', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')

      const created = await createRoomViaWs(owner, '410010', PASSWORD, {
        remoteUrl: 'https://user:pass@github.com/team/created.git',
        branch: 'main',
        autoPush: false
      })
      expect(created.room.roomId).toBe('410010')
      expect(created.room.repoConfigured).toBe(true)

      // REST 详情同样只暴露布尔值，且远端地址已剥离 userinfo
      const detail = await httpJson(h, 'GET', '/rooms/410010', { authorization: `Bearer ${owner.ticket}` })
      expect(detail.status).toBe(200)
      expect(detail.body.room.repoConfigured).toBe(true)

      const status = await httpJson(h, 'GET', '/rooms/410010/git', { authorization: `Bearer ${owner.ticket}` })
      expect(status.status).toBe(200)
      expect(status.body.configured).toBe(true)
      expect(status.body.remoteUrl).toBe('https://github.com/team/created.git')
      expect(status.body.authConfigured).toBe(true)
      expect(JSON.stringify(status.body)).not.toContain('pass')
    })

    it('验收8 房间列表与详情投影只含 repoConfigured 布尔值，绝不含 URL/token', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const created = await createRoomViaWs(owner, '410011', PASSWORD, {
        remoteUrl: 'https://example.com/team/list.git',
        auth: { type: 'token', token: 'list-secret-token' }
      })
      expect(created.room.repoConfigured).toBe(true)

      const list = await httpJson(h, 'GET', '/rooms')
      expect(list.status).toBe(200)
      const rooms = list.body.rooms as Array<Record<string, unknown>>
      const row = rooms.find(r => r.roomId === '410011')
      expect(row).toBeTruthy()
      expect(typeof row!.repoConfigured).toBe('boolean')
      expect(row!.repoConfigured).toBe(true)
      // 列表投影里不得出现任何仓库细节
      const serializedList = JSON.stringify(list.body)
      expect(serializedList).not.toContain('list-secret-token')
      expect(serializedList).not.toContain('example.com/team/list.git')
      expect(serializedList).not.toContain('remoteUrl')

      const detail = await httpJson(h, 'GET', '/rooms/410011', { authorization: `Bearer ${owner.ticket}` })
      expect(detail.status).toBe(200)
      expect(detail.body.room.repoConfigured).toBe(true)
      const serializedDetail = JSON.stringify(detail.body)
      expect(serializedDetail).not.toContain('list-secret-token')
      expect(serializedDetail).not.toContain('example.com/team/list.git')
    })

    // 契约 §4.5：踢人后该设备必须已无绑定（含它宿主上的真实路径）。
    // 服务层的 unbindWorkspace 对「已不在房间、但还留着本房绑定」的设备是放行的，
    // 否则绑定会作为残留行一直留在房主视角的状态里。
    it('验收9 房间内被踢后：该成员的绑定被清掉，宿主目录不再出现在状态里', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const member = await connectDevice(h, 'Member')
      await createRoomViaWs(owner, '410012', PASSWORD)
      await joinRoomViaWs(member, '410012', PASSWORD)
      await rpc(owner.client, 'room-git-config', {
        roomId: '410012',
        repo: { remoteUrl: 'https://example.com/team/kick.git', autoPush: false }
      }, 'cfg-kick')
      const dir = nextWorkspaceDir('wsKick')
      const bind = await rpc(member.client, 'room-workspace-bind', { roomId: '410012', path: dir }, 'bind-kick')
      expect(bindingRow(bind.payload as RoomRepoStatus, member.deviceId)?.bound).toBe(true)

      const kick = await rpc(owner.client, 'room-kick', { roomId: '410012', deviceId: member.deviceId }, 'kick-1')
      expect(kick.type).toBe('room-member-kicked')

      const status = await rpc(owner.client, 'room-git-status', { roomId: '410012' }, 'st-kick')
      const payload = status.payload as RoomRepoStatus
      expect(payload.bindings.some(b => b.deviceId === maskDeviceId(member.deviceId) && b.bound)).toBe(false)
      expect(JSON.stringify(payload)).not.toContain(fs.realpathSync.native(dir))
    })

    // 与验收9 同源：退房后该设备的绑定也必须被清掉。
    it('验收10 成员退房后：该成员的绑定被清掉', async () => {
      const h = await createE2eHarness()
      const owner = await connectDevice(h, 'Owner')
      const leaver = await connectDevice(h, 'Leaver')
      await createRoomViaWs(owner, '410013', PASSWORD)
      await joinRoomViaWs(leaver, '410013', PASSWORD)
      await rpc(owner.client, 'room-git-config', {
        roomId: '410013',
        repo: { remoteUrl: 'https://example.com/team/leave.git', autoPush: false }
      }, 'cfg-leave')
      const dir = nextWorkspaceDir('wsLeave')
      const bind = await rpc(leaver.client, 'room-workspace-bind', { roomId: '410013', path: dir }, 'bind-leave')
      expect(bindingRow(bind.payload as RoomRepoStatus, leaver.deviceId)?.bound).toBe(true)

      const left = await rpc(leaver.client, 'room-leave', { roomId: '410013' }, 'leave-1')
      expect(left.type).toBe('room-left')

      const status = await rpc(owner.client, 'room-git-status', { roomId: '410013' }, 'st-leave')
      const payload = status.payload as RoomRepoStatus
      expect(payload.bindings.some(b => b.deviceId === maskDeviceId(leaver.deviceId) && b.bound)).toBe(false)
      expect(JSON.stringify(payload)).not.toContain(fs.realpathSync.native(dir))
    })
  })

  // -------------------------------------------------------------------------
  // REST 面
  // -------------------------------------------------------------------------

  describe('REST 面', () => {
    it('验收11 七条新路由的成功路径', async () => {
      const h = await createE2eHarness()
      const { owner, member } = await setupBoundRoom(h, '410101')
      const ownerAuth = `Bearer ${owner.ticket}`
      const memberAuth = `Bearer ${member.ticket}`

      // 1) GET /rooms/:roomId/git —— 该房票据可读
      const gitStatus = await httpJson(h, 'GET', '/rooms/410101/git', { authorization: ownerAuth })
      expect(gitStatus.status).toBe(200)
      expect(gitStatus.body.configured).toBe(true)
      expect(gitStatus.body.roomId).toBe('410101')

      // 2) PUT /rooms/:roomId/git —— 房主改仓库
      const putGit = await httpJson(h, 'PUT', '/rooms/410101/git', {
        authorization: ownerAuth,
        body: { remoteUrl: 'https://example.com/team/410101-v2.git', branch: 'main', autoPush: false }
      })
      expect(putGit.status).toBe(200)
      expect(putGit.body.remoteUrl).toBe('https://example.com/team/410101-v2.git')
      expect(putGit.body.branch).toBe('main')

      // 3) PUT /rooms/:roomId/workspace —— 成员换绑到新目录（仓库身份变了，必须重新 ensureRepo）
      const dir2 = nextWorkspaceDir('ws-410101-2')
      const putWs = await httpJson(h, 'PUT', '/rooms/410101/workspace', { authorization: memberAuth, body: { path: dir2 } })
      expect(putWs.status).toBe(200)
      expect(bindingRow(putWs.body as RoomRepoStatus, member.deviceId)?.workspacePath).toBe(fs.realpathSync.native(dir2))

      // 4) POST /rooms/:roomId/git/sync —— 手动同步
      fs.writeFileSync(path.join(dir2, 'rest.txt'), 'rest')
      const sync = await httpJson(h, 'POST', '/rooms/410101/git/sync', { authorization: memberAuth })
      expect(sync.status).toBe(200)
      expect(sync.body.roomId).toBe('410101')
      expect(sync.body.result.ok).toBe(true)
      expect(sync.body.result.committed).toBe(1)
      expect(sync.body.result.pushed).toBe(false)

      // 5) GET /rooms/:roomId/workspaces —— 候选目录
      const candidates = await httpJson(h, 'GET', '/rooms/410101/workspaces', { authorization: memberAuth })
      expect(candidates.status).toBe(200)
      expect(candidates.body.roomId).toBe('410101')
      expect(Array.isArray(candidates.body.paths)).toBe(true)

      // 6) DELETE /rooms/:roomId/workspace —— 解绑
      const delWs = await httpJson(h, 'DELETE', '/rooms/410101/workspace', { authorization: memberAuth })
      expect(delWs.status).toBe(200)
      expect(bindingRow(delWs.body as RoomRepoStatus, member.deviceId)?.bound).toBe(false)

      // 7) DELETE /rooms/:roomId/git —— 房主清仓库
      const delGit = await httpJson(h, 'DELETE', '/rooms/410101/git', { authorization: ownerAuth })
      expect(delGit.status).toBe(200)
      expect(delGit.body.configured).toBe(false)
    })

    it('验收12 七条新路由缺票据一律 401 invalid-ticket', async () => {
      const h = await createE2eHarness()
      await setupBoundRoom(h, '410102')

      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/rooms/410102/git'],
        ['PUT', '/rooms/410102/git', { remoteUrl: 'https://example.com/x.git' }],
        ['DELETE', '/rooms/410102/git'],
        ['PUT', '/rooms/410102/workspace', { path: 'C:\\tmp' }],
        ['DELETE', '/rooms/410102/workspace'],
        ['POST', '/rooms/410102/git/sync'],
        ['GET', '/rooms/410102/workspaces']
      ]
      for (const [method, route, body] of routes) {
        const res = await httpJson(h, method, route, { body })
        expect(res.status, `${method} ${route}`).toBe(401)
        expect(res.body.error.code, `${method} ${route}`).toBe('invalid-ticket')
      }
    })

    it('验收13 非房主调房主路由 → 403 forbidden', async () => {
      const h = await createE2eHarness()
      const { member } = await setupBoundRoom(h, '410103')
      const auth = `Bearer ${member.ticket}`

      const putGit = await httpJson(h, 'PUT', '/rooms/410103/git', {
        authorization: auth,
        body: { remoteUrl: 'https://example.com/x.git' }
      })
      expect(putGit.status).toBe(403)
      expect(putGit.body.error.code).toBe('forbidden')

      const delGit = await httpJson(h, 'DELETE', '/rooms/410103/git', { authorization: auth })
      expect(delGit.status).toBe(403)
      expect(delGit.body.error.code).toBe('forbidden')
    })

    it('验收14 方法不匹配 → 405', async () => {
      const h = await createE2eHarness()
      const { owner } = await setupBoundRoom(h, '410104')
      const auth = `Bearer ${owner.ticket}`

      const cases: Array<[string, string]> = [
        ['POST', '/rooms/410104/git'],
        ['GET', '/rooms/410104/workspace'],
        ['GET', '/rooms/410104/git/sync'],
        ['POST', '/rooms/410104/workspaces']
      ]
      for (const [method, route] of cases) {
        const res = await httpJson(h, method, route, { authorization: auth })
        expect(res.status, `${method} ${route}`).toBe(405)
      }
    })
  })
})
