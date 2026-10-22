/**
 * RoomWorkspaceService 单元测试（冻结契约 §6.1 的逐条验收）。
 *
 * 范围：只测 src/room-workspace.ts 这一个服务（以及它依赖的 rooms / git-sync），
 * 不接 WS、不接 REST、不接客户端。每个用例 new Context() + new RoomService +
 * new GitSyncService + setScryptParams 把 scrypt 成本调到 N=1024，afterEach 依次
 * shutdown 三个服务，避免去抖定时器与 git-sync 的内存登记跨用例泄漏。
 *
 * 推送用例内嵌一个最小 smart-HTTP 服务器（info/refs 回 advertise，git-receive-pack
 * 回 report-status 的 `unpack ok` + `ok <ref>`）。契约 §2 明确 isomorphic-git 只支持
 * http(s)，本地目录远端不可用，所以只能起真服务器。
 *
 * 跑法（禁止 npm / npx / pnpm，也不要给命令加 2>&1）：
 *   node node_modules/vitest/vitest.mjs --run test/room-workspace.test.ts
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import * as Git from 'isomorphic-git'
import * as fsSync from 'fs'
import * as fsPromises from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { RoomService, isRoomError, maskDeviceId } from '../src/rooms.js'
import { GitSyncService } from '../src/git-sync.js'
import {
  RoomWorkspaceService,
  type RoomGitConfig,
  type RoomRepoConfigInput,
  type RoomRepoStatus,
  type SyncSummary,
} from '../src/room-workspace.js'

// ---------------------------------------------------------------------------
// 临时目录与内嵌 smart-HTTP 服务器
// ---------------------------------------------------------------------------

const tmpdir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'room-workspace-test-'))

const servers: Server[] = []

afterAll(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  fsSync.rmSync(tmpdir, { recursive: true, force: true })
})

/** 把负载包成 pkt-line（4 位十六进制长度 + 负载）。 */
function pktLineBytes(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from((payload.length + 4).toString(16).padStart(4, '0'), 'utf8'), payload])
}

function pktLine(line: string): Buffer {
  return pktLineBytes(Buffer.from(line, 'utf8'))
}

/**
 * 从 push 请求的命令段解出目标 ref（第一个 flush-pkt 之前）。
 *
 * 为什么必须回显请求里的 ref：isomorphic-git 在 push 成功后要读
 * `result.refs[fullRemoteRef].ok`，回一个没被请求过的 ref 会变成
 * `undefined.ok` 直接 TypeError。
 */
function requestTargetRef(body: Buffer): string {
  let cursor = 0
  while (cursor + 4 <= body.length) {
    const length = Number.parseInt(body.slice(cursor, cursor + 4).toString('utf8'), 16)
    if (length === 0) break // flush：命令段结束，后面是 packfile
    if (length < 4 || cursor + length > body.length) break
    const line = body.slice(cursor + 4, cursor + length).toString('utf8')
    const match = /(refs\/[A-Za-z0-9._/-]+)/.exec(line)
    if (match) return match[1]
    cursor += length
  }
  return 'refs/heads/main'
}

interface SmartHttpRemote {
  url: string
  pushCount: () => number
}

/**
 * 最小 smart-HTTP 服务器（契约 §6.1 要求）。
 *
 * - GET  `.../info/refs?service=git-receive-pack` → advertise：空仓库 + report-status
 *   与 side-band-64k 能力（isomorphic-git 的 push 固定读 side-band 的 band 1，
 *   不协商 side-band-64k 时 report-status 会落到 packetlines 而它去读 packfile）。
 * - POST `.../git-receive-pack` → report-status：`unpack ok` + `ok <请求的 ref>`。
 */
function startSmartHttpServer(): Promise<SmartHttpRemote> {
  return new Promise(resolve => {
    let pushes = 0
    const server = createServer((req, res) => {
      const parsed = new URL(req.url ?? '/', 'http://127.0.0.1')

      if (req.method === 'GET' && parsed.pathname.endsWith('/info/refs') && parsed.searchParams.get('service') === 'git-receive-pack') {
        // 空仓库：40 个 0 的 capabilities^{} 占位行，refs 保持为空，push 时 oldoid 即全 0。
        const body = Buffer.concat([
          pktLine('# service=git-receive-pack\n'),
          Buffer.from('0000', 'utf8'),
          pktLine(`${'0'.repeat(40)} capabilities^{}\x00report-status side-band-64k\n`),
          Buffer.from('0000', 'utf8'),
        ])
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-advertisement',
          'content-length': String(body.length),
        })
        res.end(body)
        return
      }

      if (req.method === 'POST' && parsed.pathname.endsWith('/git-receive-pack')) {
        const chunks: Buffer[] = []
        req.on('data', chunk => chunks.push(Buffer.from(chunk)))
        req.on('end', () => {
          pushes += 1
          const ref = requestTargetRef(Buffer.concat(chunks))
          // side-band-64k：band 1 的负载是「band 字节 + 内层 pkt-line」，
          // 这样 isomorphic-git 剥掉外层后拿到的仍是完整 pkt-line 流。
          const inner = Buffer.concat([pktLine('unpack ok\n'), pktLine(`ok ${ref}\n`)])
          const body = Buffer.concat([
            pktLineBytes(Buffer.concat([Buffer.from([1]), inner])),
            Buffer.from('0000', 'utf8'),
          ])
          res.writeHead(200, {
            'content-type': 'application/x-git-receive-pack-result',
            'content-length': String(body.length),
          })
          res.end(body)
        })
        return
      }

      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${address.port}/repo.git`,
        pushCount: () => pushes,
      })
    })
  })
}

/** 取一个当前没人监听的端口（bind 完立刻放开），用来验证「远端不可达」。 */
function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

interface Harness {
  rooms: RoomService
  gitSync: GitSyncService
  workspace: RoomWorkspaceService
}

const harnesses: Harness[] = []

function createHarness(git: Partial<RoomGitConfig> = {}): Harness {
  const ctx = new Context()
  const rooms = new RoomService(ctx)
  rooms.initialize({ minPasswordLength: 3 })
  // scrypt 成本调低：存储串自带参数，调低只影响新建哈希，不影响正确性。
  rooms.setScryptParams({ N: 1024, r: 8, p: 1 })
  const gitSync = new GitSyncService(ctx)
  gitSync.initialize()
  const workspace = new RoomWorkspaceService(ctx, rooms, gitSync)
  workspace.initialize(git)
  const harness = { rooms, gitSync, workspace }
  harnesses.push(harness)
  return harness
}

afterEach(() => {
  for (const harness of harnesses.splice(0)) {
    harness.workspace.shutdown()
    harness.gitSync.shutdown()
    harness.rooms.shutdown()
  }
})

let deviceSeq = 0

interface Device {
  deviceId: string
  deviceName: string
}

function registerDevice(rooms: RoomService, name?: string): Device {
  deviceSeq += 1
  const result = rooms.registerDevice({ deviceName: name ?? `设备 ${deviceSeq}` })
  return { deviceId: result.deviceId, deviceName: result.deviceName }
}

const PASSWORD = 'pass-1234'

async function createOwnedRoom(harness: Harness, roomId: string): Promise<{ owner: Device; roomId: string }> {
  const owner = registerDevice(harness.rooms)
  await harness.rooms.createRoom({
    roomId,
    name: '测试房',
    password: PASSWORD,
    deviceId: owner.deviceId,
    deviceName: owner.deviceName,
    sessionId: `sess-${owner.deviceId}`,
  })
  return { owner, roomId }
}

async function joinMember(harness: Harness, roomId: string, name?: string): Promise<Device> {
  const device = registerDevice(harness.rooms, name)
  await harness.rooms.joinRoom({
    roomId,
    password: PASSWORD,
    deviceId: device.deviceId,
    deviceName: device.deviceName,
    sessionId: `sess-${device.deviceId}`,
  })
  return device
}

let dirSeq = 0

/** 每个工作区一个独立真实目录：isomorphic-git 直接操作文件系统，不 mock。 */
function workspaceDir(prefix = 'ws'): string {
  dirSeq += 1
  const dir = path.join(tmpdir, `${prefix}-${dirSeq}`)
  fsSync.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 配好仓库的房间 + 一个已进房的成员 + 一个空工作区目录（尚未绑定）。
 * 默认 autoPush 关掉：提交用例不该被「远端不可达」干扰。
 */
async function configuredRoom(
  harness: Harness,
  roomId: string,
  repo: Partial<RoomRepoConfigInput> = {}
): Promise<{ owner: Device; member: Device; dir: string; roomId: string }> {
  const { owner } = await createOwnedRoom(harness, roomId)
  await harness.workspace.configureRepo(roomId, owner.deviceId, {
    remoteUrl: 'https://example.com/room.git',
    autoPush: false,
    ...repo,
  })
  const member = await joinMember(harness, roomId)
  return { owner, member, dir: workspaceDir(), roomId }
}

/** 捕获异步抛出的 RoomError，便于断言 code。 */
async function caught(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error) {
    if (!isRoomError(error)) throw error
    return error
  }
  throw new Error('expected the promise to reject with a RoomError')
}

/**
 * status() 是同步方法，抛错不会被 Promise 接住；这里把它包成一次调用再捕获。
 */
function caughtSync(fn: () => unknown): { code: string; message: string } {
  try {
    fn()
  } catch (error) {
    if (!isRoomError(error)) throw error
    return error
  }
  throw new Error('expected the call to throw a RoomError')
}

/** 本地仓库的提交总数，用来断言「有没有真的多出一个 commit」。 */
async function commitCount(dir: string): Promise<number> {
  try {
    const commits = await Git.log({ fs: fsSync, dir })
    return commits.length
  } catch {
    // 还没有任何提交时 Git.log 会抛 NotFoundError。
    return 0
  }
}

// ---------------------------------------------------------------------------
// 配置校验（§4.2 规则 2）
// ---------------------------------------------------------------------------

describe('配置校验（§4.2 规则 2）', () => {
  it('非 http(s) 的远端 URL 一律 invalid-repo，且房间不留半配置状态', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710001')

    for (const remoteUrl of ['ssh://git@host/repo.git', 'git://host/repo.git', 'file:///tmp/repo.git', 'ftp://host/repo.git']) {
      const error = await caught(harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl }))
      expect(error.code).toBe('invalid-repo')
    }

    // 校验失败不得落盘：房间仍是未配置（§4.2 规则 2「先挡一次」的意义）。
    expect(harness.workspace.status(roomId, owner.deviceId).configured).toBe(false)
    expect(harness.rooms.getRoomInfo(roomId, owner.deviceId).repoConfigured).toBe(false)
  })

  it('validateRepoConfig 是纯校验：合法输入不联网不落盘，房间仍是未配置', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710002')

    expect(() => harness.workspace.validateRepoConfig({ remoteUrl: 'https://example.com/repo.git' })).not.toThrow()
    expect(() => harness.workspace.validateRepoConfig({ remoteUrl: 'ssh://host/repo.git' })).toThrowError(
      expect.objectContaining({ code: 'invalid-repo' })
    )
    expect(harness.workspace.status(roomId, owner.deviceId).configured).toBe(false)
  })

  it('内嵌 userinfo 被剥离并转成 auth，投影里绝不出现 token（§3）', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710003')
    const token = 'tok-secret-abc123'

    const status = await harness.workspace.configureRepo(roomId, owner.deviceId, {
      remoteUrl: `https://oauth2:${token}@example.com/team/repo.git`,
    })

    expect(status.configured).toBe(true)
    expect(status.authConfigured).toBe(true)
    expect(status.remoteUrl).toBe('https://example.com/team/repo.git')
    const json = JSON.stringify(status)
    expect(json).not.toContain(token)
    expect(json).not.toContain('oauth2')
    // §3：房间公开投影只多一个布尔位。
    expect(harness.rooms.getRoomInfo(roomId, owner.deviceId).repoConfigured).toBe(true)
  })

  it('userinfo 只有用户名位置时按「用户名即令牌」解析，仍然剥离', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710004')
    const token = 'tok-user-only-xyz'

    const status = await harness.workspace.configureRepo(roomId, owner.deviceId, {
      remoteUrl: `https://${token}@example.com/repo.git`,
    })

    expect(status.authConfigured).toBe(true)
    expect(status.remoteUrl).toBe('https://example.com/repo.git')
    expect(JSON.stringify(status)).not.toContain(token)
  })

  it('同时给 auth 与内嵌 userinfo 一律 invalid-repo（说不清用哪份凭据）', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710005')

    const error = await caught(
      harness.workspace.configureRepo(roomId, owner.deviceId, {
        remoteUrl: 'https://oauth2:tok@example.com/repo.git',
        auth: { type: 'token', token: 'other' },
      })
    )
    expect(error.code).toBe('invalid-repo')
  })

  it('非法分支（含 ..、以 - 开头、空格、超长、空）一律 invalid-repo', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710006')

    for (const branch of ['feature..x', '-bad', 'a b', '', 'a'.repeat(129)]) {
      const error = await caught(
        harness.workspace.configureRepo(roomId, owner.deviceId, {
          remoteUrl: 'https://example.com/repo.git',
          branch,
        })
      )
      expect(error.code).toBe('invalid-repo')
    }
  })

  it('roomGit.enabled === false 时所有写操作一律 forbidden（读操作不受影响）', async () => {
    const harness = createHarness({ enabled: false })
    const { owner, roomId } = await createOwnedRoom(harness, '710007')
    const member = await joinMember(harness, roomId)
    const dir = workspaceDir()

    expect((await caught(harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' }))).code).toBe('forbidden')
    expect((await caught(harness.workspace.bindWorkspace(roomId, member.deviceId, dir))).code).toBe('forbidden')
    expect((await caught(harness.workspace.sync(roomId, member.deviceId))).code).toBe('forbidden')
    // 读路径不因 enabled=false 而失败。
    expect(harness.workspace.status(roomId, owner.deviceId).configured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 权限（§4.2 规则 1）
// ---------------------------------------------------------------------------

describe('权限（§4.2 规则 1）', () => {
  it('成员调房主操作 → forbidden；非成员调任何操作 → not-a-member', async () => {
    const harness = createHarness()
    const { roomId } = await createOwnedRoom(harness, '710011')
    const member = await joinMember(harness, roomId)
    const outsider = registerDevice(harness.rooms, '外人')
    const dir = workspaceDir()

    expect((await caught(harness.workspace.configureRepo(roomId, member.deviceId, { remoteUrl: 'https://example.com/repo.git' }))).code).toBe('forbidden')
    expect((await caught(harness.workspace.clearRepo(roomId, member.deviceId))).code).toBe('forbidden')
    expect((await caught(harness.workspace.configureRepo(roomId, outsider.deviceId, { remoteUrl: 'https://example.com/repo.git' }))).code).toBe('not-a-member')
    expect((await caught(harness.workspace.bindWorkspace(roomId, outsider.deviceId, dir))).code).toBe('not-a-member')
    expect(caughtSync(() => harness.workspace.status(roomId, outsider.deviceId)).code).toBe('not-a-member')
    expect((await caught(harness.workspace.sync(roomId, outsider.deviceId))).code).toBe('not-a-member')
  })

  it('clearRepo 只允许房主：成员调用 forbidden，房主调用后 repoConfigured 归零', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710012')
    const member = await joinMember(harness, roomId)
    await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' })

    expect((await caught(harness.workspace.clearRepo(roomId, member.deviceId))).code).toBe('forbidden')

    const status = await harness.workspace.clearRepo(roomId, owner.deviceId)
    expect(status.configured).toBe(false)
    expect(status.remoteUrl).toBeUndefined()
    expect(harness.rooms.getRoomInfo(roomId, owner.deviceId).repoConfigured).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 绑定（§4.2 规则 3）
// ---------------------------------------------------------------------------

describe('绑定（§4.2 规则 3）', () => {
  it('相对路径 / 不存在的目录 / 不是目录 → invalid-workspace，且不留绑定', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710021')
    const member = await joinMember(harness, roomId)
    const dir = workspaceDir()
    await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' })

    expect((await caught(harness.workspace.bindWorkspace(roomId, member.deviceId, 'relative/path'))).code).toBe('invalid-workspace')
    expect((await caught(harness.workspace.bindWorkspace(roomId, member.deviceId, path.join(tmpdir, 'no-such-dir-xyz')))).code).toBe('invalid-workspace')
    const filePath = path.join(dir, 'a-file.txt')
    fsSync.writeFileSync(filePath, 'x')
    expect((await caught(harness.workspace.bindWorkspace(roomId, member.deviceId, filePath))).code).toBe('invalid-workspace')

    expect(harness.workspace.status(roomId, member.deviceId).bindings.some(b => b.bound)).toBe(false)
  })

  it('房间未配置仓库时绑定 → invalid-repo（先让房主设置仓库）', async () => {
    const harness = createHarness()
    const { roomId } = await createOwnedRoom(harness, '710022')
    const member = await joinMember(harness, roomId)

    const error = await caught(harness.workspace.bindWorkspace(roomId, member.deviceId, workspaceDir()))
    expect(error.code).toBe('invalid-repo')
  })

  it('绑定后目录被 git init，状态带 repoReady，且路径只对本人与房主可见', async () => {
    const harness = createHarness()
    const { owner, member, dir, roomId } = await configuredRoom(harness, '710023')

    const status = await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    expect(fsSync.existsSync(path.join(dir, '.git'))).toBe(true)
    expect(status.bindings.find(b => b.deviceName === member.deviceName)?.repoReady).toBe(true)

    const selfRow = harness.workspace.status(roomId, member.deviceId).bindings.find(b => b.deviceName === member.deviceName)
    expect(selfRow?.bound).toBe(true)
    expect(selfRow?.workspacePath).toBe(dir)

    const ownerRow = harness.workspace.status(roomId, owner.deviceId).bindings.find(b => b.deviceName === member.deviceName)
    expect(ownerRow?.workspacePath).toBe(dir)
  })

  it('同设备重复绑定是更新而不是新增；超出 maxBindingsPerRoom 用 invalid-argument', async () => {
    const harness = createHarness({ maxBindingsPerRoom: 1 })
    const { owner, roomId } = await createOwnedRoom(harness, '710024')
    await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' })
    const member = await joinMember(harness, roomId)
    const dirA = workspaceDir('a')
    const dirB = workspaceDir('b')

    // 同一设备换目录再绑一次：仍是 1 条绑定，且指向新目录。
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dirA)
    const updated = await harness.workspace.bindWorkspace(roomId, member.deviceId, dirB)
    expect(updated.bindings.filter(b => b.bound)).toHaveLength(1)
    expect(updated.bindings.find(b => b.deviceName === member.deviceName)?.workspacePath).toBe(dirB)

    // 换个设备再绑就超限（同设备更新不占名额，所以这里必须换设备）。
    const other = await joinMember(harness, roomId, '另一个设备')
    const error = await caught(harness.workspace.bindWorkspace(roomId, other.deviceId, workspaceDir('c')))
    expect(error.code).toBe('invalid-argument')
  })
})

// ---------------------------------------------------------------------------
// 提交（§4.1 / §4.2 规则 4）
// ---------------------------------------------------------------------------

describe('提交（§4.1 / §4.2 规则 4）', () => {
  it('新增/修改/删除文件后同步，committed 数量与 commitOid 正确', async () => {
    const harness = createHarness()
    const { member, dir, roomId } = await configuredRoom(harness, '710031')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'v1')
    await fsPromises.writeFile(path.join(dir, 'b.txt'), 'v1')
    const first = await harness.workspace.sync(roomId, member.deviceId)

    expect(first.ok).toBe(true)
    expect(first.trigger).toBe('manual')
    expect(first.committed).toBe(2)
    expect(first.commitOid).toMatch(/^[0-9a-f]{40}$/)
    expect(await commitCount(dir)).toBe(1)

    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'v2-changed-content')
    await fsPromises.writeFile(path.join(dir, 'c.txt'), 'new')
    await fsPromises.rm(path.join(dir, 'b.txt'))
    const second = await harness.workspace.sync(roomId, member.deviceId)

    expect(second.committed).toBe(3)
    expect(second.commitOid).not.toBe(first.commitOid)
    expect(await commitCount(dir)).toBe(2)
  })

  it('无变化时 committed=0，且不产生新 commit', async () => {
    const harness = createHarness()
    const { member, dir, roomId } = await configuredRoom(harness, '710032')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'once')
    await harness.workspace.sync(roomId, member.deviceId)

    const before = await commitCount(dir)
    const result = await harness.workspace.sync(roomId, member.deviceId)

    expect(result.ok).toBe(true)
    expect(result.committed).toBe(0)
    expect(result.commitOid).toBeUndefined()
    expect(await commitCount(dir)).toBe(before)
  })

  it('autoCommit=false 时自动触发直接跳过（连去抖窗口都不开），手动同步仍然提交', async () => {
    const harness = createHarness({ debounceMs: 20 })
    const { member, dir, roomId } = await configuredRoom(harness, '710033', { autoCommit: false })
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')

    const autoResults = await harness.workspace.handleWorkspaceChanges(dir, { files: [{ path: 'a.txt' }], total: 1 })
    expect(autoResults).toEqual([])
    expect(await commitCount(dir)).toBe(0)

    const manual = await harness.workspace.sync(roomId, member.deviceId, 'manual')
    expect(manual.committed).toBe(1)
    expect(await commitCount(dir)).toBe(1)
  })

  it('autoPush=false 时只提交不推送', async () => {
    const harness = createHarness()
    const { member, dir, roomId } = await configuredRoom(harness, '710034')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')

    const result = await harness.workspace.sync(roomId, member.deviceId)

    expect(result.ok).toBe(true)
    expect(result.committed).toBe(1)
    expect(result.pushed).toBe(false)
  })

  it('sync() 在「未绑定 / 未配置仓库 / 绑定未就绪」时抛错（§4.3 把码留给这一层）', async () => {
    const harness = createHarness()
    const { owner, member, dir, roomId } = await configuredRoom(harness, '710035')

    // 还没绑定。
    expect((await caught(harness.workspace.sync(roomId, member.deviceId))).code).toBe('sync-failed')

    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    // 房主清掉仓库：绑定立刻失效（repoReady=false）。
    await harness.workspace.clearRepo(roomId, owner.deviceId)
    expect((await caught(harness.workspace.sync(roomId, member.deviceId))).code).toBe('invalid-repo')

    // 重新配置一个不同远端（autoPush 必须跟着关掉，否则本用例会被推送失败干扰）。
    await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/other.git', autoPush: false })
    expect((await caught(harness.workspace.sync(roomId, member.deviceId))).code).toBe('invalid-workspace')

    // 重新绑定后恢复可用。
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')
    const ok = await harness.workspace.sync(roomId, member.deviceId)
    expect(ok.ok).toBe(true)
    expect(ok.committed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 推送（§4.1 / §6.1）
// ---------------------------------------------------------------------------

describe('推送（§4.1 / §6.1）', () => {
  /**
   * 这里刻意**不传 branch**，用契约 §4.2 规则 2 的默认值 'main'。
   *
   * 这是一条回归：ensureRepo 必须把配置的分支传给 Git.init。isomorphic-git 的
   * Git.init 默认建 master，早先把房间仓库默认分支设成 main 时，绑定后本地是
   * refs/heads/master，而 commitAndPush 固定推 repo.branch，push 会直接
   * NotFoundError: Could not find main。所以默认分支这条路径必须被用例钉住。
   */
  it('内嵌最小 smart-HTTP 服务器：push 成功路径 pushed=true、error 为空', async () => {
    const remote = await startSmartHttpServer()
    const harness = createHarness({ pushTimeoutMs: 5000 })
    const { member, dir, roomId } = await configuredRoom(harness, '710041', { remoteUrl: remote.url, autoPush: true })
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'push me')

    const result = await harness.workspace.sync(roomId, member.deviceId)

    expect(result.ok).toBe(true)
    expect(result.pushed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.committed).toBe(1)
    expect(remote.pushCount()).toBe(1)
  })

  it('默认分支是 main：绑定后本地分支与配置分支一致（ensureRepo 传了 defaultBranch）', async () => {
    const harness = createHarness()
    const { member, dir, roomId } = await configuredRoom(harness, '710044', {
      remoteUrl: 'https://example.com/team/default-branch.git',
      autoPush: false
    })
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    const repoId = `room:${roomId}`
    const head = await harness.gitSync.getHead(repoId)
    expect(head.branch).toBe('main')
  })

  it('连续两次推送各自成功：report-status 每次都回显请求里的 ref', async () => {
    const remote = await startSmartHttpServer()
    const harness = createHarness({ pushTimeoutMs: 5000 })
    const { member, dir, roomId } = await configuredRoom(harness, '710042', { remoteUrl: remote.url, autoPush: true })
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'one')
    const first = await harness.workspace.sync(roomId, member.deviceId)
    expect(first.ok).toBe(true)
    expect(first.pushed).toBe(true)

    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'two-longer')
    const second = await harness.workspace.sync(roomId, member.deviceId)

    expect(second.ok).toBe(true)
    expect(second.pushed).toBe(true)
    expect(second.commitOid).not.toBe(first.commitOid)
    expect(remote.pushCount()).toBe(2)
  })

  it('远端不可达时 ok=false、error 非空，commit 仍然落盘', async () => {
    const port = await unusedPort()
    const harness = createHarness({ pushTimeoutMs: 5000 })
    const { member, dir, roomId } = await configuredRoom(harness, '710043', {
      remoteUrl: `http://127.0.0.1:${port}/repo.git`,
      autoPush: true,
    })
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'commit only')

    const result = await harness.workspace.sync(roomId, member.deviceId)

    expect(result.ok).toBe(false)
    expect(result.pushed).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.committed).toBe(1)
    expect(result.commitOid).toMatch(/^[0-9a-f]{40}$/)
    // 提交确实落盘了：失败必须可见，但已提交的内容不能丢。
    expect(await commitCount(dir)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 自动钩子（§4.2 规则 5）
// ---------------------------------------------------------------------------

describe('自动钩子（§4.2 规则 5）', () => {
  it('cwd 命中绑定 → 去抖后触发一次同步', async () => {
    const harness = createHarness({ debounceMs: 30 })
    const { member, dir, roomId } = await configuredRoom(harness, '710051')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'auto')

    const results = await harness.workspace.handleWorkspaceChanges(dir, { files: [{ path: 'a.txt' }], total: 1 })

    expect(results).toHaveLength(1)
    expect(results[0].trigger).toBe('auto')
    expect(results[0].ok).toBe(true)
    expect(results[0].committed).toBe(1)
    expect(await commitCount(dir)).toBe(1)
  })

  it('debounceMs 内多次触发合并为一次（被合并的触发复用同一个 promise）', async () => {
    const harness = createHarness({ debounceMs: 200 })
    const { member, dir, roomId } = await configuredRoom(harness, '710052')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'one')
    const first = harness.workspace.handleWorkspaceChanges(dir, { files: [{ path: 'a.txt' }], total: 1 })
    await fsPromises.writeFile(path.join(dir, 'b.txt'), 'two')
    const second = harness.workspace.handleWorkspaceChanges(dir, { files: [{ path: 'b.txt' }], total: 1 })

    const results = await Promise.all([first, second])

    expect(results).toHaveLength(2)
    // 两次调用拿到的是同一个 promise 的同一份结果（只是各自被 Promise.all 包成了数组）。
    expect(results[0][0]).toBe(results[1][0])
    // 两个文件在同一个去抖窗口里，只产生一个 commit。
    expect(results[0][0].committed).toBe(2)
    expect(await commitCount(dir)).toBe(1)
  })

  it('total=0 不触发（没有变更就不必开去抖窗口）', async () => {
    const harness = createHarness({ debounceMs: 30 })
    const { member, dir, roomId } = await configuredRoom(harness, '710053')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)

    const results = await harness.workspace.handleWorkspaceChanges(dir, { files: [], total: 0 })

    expect(results).toEqual([])
    expect(await commitCount(dir)).toBe(0)
  })

  it('cwd 不匹配不触发', async () => {
    const harness = createHarness({ debounceMs: 30 })
    const { member, dir, roomId } = await configuredRoom(harness, '710054')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')

    const results = await harness.workspace.handleWorkspaceChanges(workspaceDir('other'), { files: [{ path: 'x.txt' }], total: 1 })

    expect(results).toEqual([])
    expect(await commitCount(dir)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 并发（§4.2 规则 4）
// ---------------------------------------------------------------------------

describe('并发（§4.2 规则 4）', () => {
  it('同一绑定同时两次 sync() 串行执行，第二次不产生重复 commit', async () => {
    const harness = createHarness()
    const { member, dir, roomId } = await configuredRoom(harness, '710061')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')

    const [first, second] = await Promise.all([
      harness.workspace.sync(roomId, member.deviceId, 'manual'),
      harness.workspace.sync(roomId, member.deviceId, 'manual'),
    ])

    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    // 第一次真的提交，第二次在第一次结束后只看到「无变化」。
    expect(first.committed).toBe(1)
    expect(second.committed).toBe(0)
    expect(await commitCount(dir)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// 房间关闭清理（§4.2 规则 6）
// ---------------------------------------------------------------------------

describe('房间关闭清理（§4.2 规则 6）', () => {
  it('onRoomClosed 清掉配置与绑定、清定时器：status 不再返回该房配置，挂起的自动同步被兑现', async () => {
    const harness = createHarness({ debounceMs: 3000 })
    const { member, dir, roomId } = await configuredRoom(harness, '710071')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')

    // 开一个去抖窗口但不 await，制造「关房时有定时器在飞」的状态。
    const pending = harness.workspace.handleWorkspaceChanges(dir, { files: [{ path: 'a.txt' }], total: 1 })
    harness.workspace.onRoomClosed(roomId)

    const status = harness.workspace.status(roomId, member.deviceId)
    expect(status.configured).toBe(false)
    expect(status.bindings.every(b => b.bound === false)).toBe(true)
    expect(harness.rooms.getRoomInfo(roomId, member.deviceId).repoConfigured).toBe(false)
    // git-sync 侧的登记也要注销，否则明文 token 会一直留在内存里。
    expect(harness.gitSync.getRepo(`room:${roomId}`)).toBeUndefined()

    const [summary] = await pending
    expect(summary.ok).toBe(false)
    expect(summary.error).toBe('房间已关闭')
    expect(await commitCount(dir)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// 解绑与成员离开（§4.2 规则 1 与规则 6 的交汇）
// ---------------------------------------------------------------------------

describe('解绑与成员离开（§4.2 规则 1 与规则 6 的交汇）', () => {
  /**
   * 契约规则 1 要求「非成员 → not-a-member」，规则 6 又要求踢人/退房后由 gateway 调
   * unbindWorkspace 清理。清理发生时设备已被移出成员表，先判成员必然 not-a-member，
   * 绑定（含内存里的 token）会一直留到进程关闭。所以：已离开的成员允许清掉自己那条
   * 绑定，而「既不是成员、也没有本房绑定」的越权调用仍然被拒。
   */
  it('被踢/退房后 unbindWorkspace 清得掉残留绑定（否则 token 一直留在内存里）', async () => {
    const harness = createHarness()
    const { owner, member, dir, roomId } = await configuredRoom(harness, '710072')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    expect(harness.workspace.status(roomId, owner.deviceId).bindings.some(b => b.bound)).toBe(true)

    await harness.rooms.leaveRoom(roomId, member.deviceId)
    await harness.workspace.unbindWorkspace(roomId, member.deviceId)

    const status = harness.workspace.status(roomId, owner.deviceId)
    expect(status.bindings.some(b => b.deviceId === maskDeviceId(member.deviceId) && b.bound)).toBe(false)
    expect(JSON.stringify(status)).not.toContain(fsSync.realpathSync.native(dir))
  })

  it('既不是成员、也没有本房绑定的设备调解绑仍被拒（not-a-member）', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710073')
    await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' })
    const outsider = registerDevice(harness.rooms, '外人')

    const result = await caught(harness.workspace.unbindWorkspace(roomId, outsider.deviceId))
    expect(result.code).toBe('not-a-member')
  })
})

// ---------------------------------------------------------------------------
// 开关（§4.2 规则 2）
// ---------------------------------------------------------------------------

describe('开关（§4.2 规则 2）', () => {
  /**
   * enabled=false 时 validateRepoConfig 也必须挡：门禁在建房前先调它，否则带 repo 的
   * 建房会「先把房间建出来、再因 configureRepo 回 forbidden」，留下一个配不上仓库的房间。
   */
  it('enabled=false 时 validateRepoConfig 抛 forbidden（纯内存判定，不联网不落盘）', () => {
    const harness = createHarness({ enabled: false })
    const result = caughtSync(() =>
      harness.workspace.validateRepoConfig({ remoteUrl: 'https://example.com/repo.git' })
    )
    expect(result.code).toBe('forbidden')
  })
})

// ---------------------------------------------------------------------------
// 投影脱敏（§3）
// ---------------------------------------------------------------------------

describe('投影脱敏（§3）', () => {
  it('非房主成员看不到别人的 workspacePath，房主可见全部', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710081')
    await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' })
    const alice = await joinMember(harness, roomId, 'Alice')
    const bob = await joinMember(harness, roomId, 'Bob')
    const aliceDir = workspaceDir('alice')
    const bobDir = workspaceDir('bob')
    await harness.workspace.bindWorkspace(roomId, alice.deviceId, aliceDir)
    await harness.workspace.bindWorkspace(roomId, bob.deviceId, bobDir)

    const bobView: RoomRepoStatus = harness.workspace.status(roomId, bob.deviceId)
    expect(bobView.bindings.find(b => b.deviceName === 'Bob')?.workspacePath).toBe(bobDir)
    expect(bobView.bindings.find(b => b.deviceName === 'Alice')?.workspacePath).toBeUndefined()

    const ownerView = harness.workspace.status(roomId, owner.deviceId)
    expect(ownerView.bindings.find(b => b.deviceName === 'Alice')?.workspacePath).toBe(aliceDir)
    expect(ownerView.bindings.find(b => b.deviceName === 'Bob')?.workspacePath).toBe(bobDir)
  })

  it('token 与真 deviceId 不出现在任何投影的 JSON 序列化结果里', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710082')
    const token = 'super-secret-token-000'
    await harness.workspace.configureRepo(roomId, owner.deviceId, {
      remoteUrl: `https://oauth2:${token}@example.com/repo.git`,
    })
    const member = await joinMember(harness, roomId)
    await harness.workspace.bindWorkspace(roomId, member.deviceId, workspaceDir())

    const payloads: unknown[] = [
      harness.workspace.status(roomId, owner.deviceId),
      harness.workspace.status(roomId, member.deviceId),
      harness.rooms.getRoomInfo(roomId, owner.deviceId),
      harness.rooms.getMembers(roomId, member.deviceId),
    ]
    const json = JSON.stringify(payloads)

    expect(json).not.toContain(token)
    expect(json).not.toContain(owner.deviceId)
    expect(json).not.toContain(member.deviceId)
  })
})

// ---------------------------------------------------------------------------
// 事件（§4.2 自建 emitter）
// ---------------------------------------------------------------------------

describe('事件（§4.2）', () => {
  it('sync-finished 携带 roomId / deviceId / SyncSummary，失败也照发', async () => {
    const harness = createHarness()
    const { member, dir, roomId } = await configuredRoom(harness, '710091')
    await harness.workspace.bindWorkspace(roomId, member.deviceId, dir)
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'x')

    const finished: SyncSummary[] = []
    const unsubscribe = harness.workspace.on('sync-finished', (_roomId, _deviceId, summary) => finished.push(summary))
    try {
      await harness.workspace.sync(roomId, member.deviceId)
    } finally {
      unsubscribe()
    }

    expect(finished).toHaveLength(1)
    expect(finished[0].ok).toBe(true)
    expect(finished[0].committed).toBe(1)
  })

  it('status-changed 在房主配置/清除仓库后广播脱敏后的 RoomRepoStatus', async () => {
    const harness = createHarness()
    const { owner, roomId } = await createOwnedRoom(harness, '710092')
    const seen: RoomRepoStatus[] = []
    const unsubscribe = harness.workspace.on('status-changed', (_roomId, status) => seen.push(status))
    try {
      await harness.workspace.configureRepo(roomId, owner.deviceId, { remoteUrl: 'https://example.com/repo.git' })
      await harness.workspace.clearRepo(roomId, owner.deviceId)
    } finally {
      unsubscribe()
    }

    expect(seen).toHaveLength(2)
    expect(seen[0].configured).toBe(true)
    // 广播的是脱敏投影：远端可见，凭据不可见。
    expect(seen[0].remoteUrl).toBe('https://example.com/repo.git')
    expect(seen[1].configured).toBe(false)
  })
})
