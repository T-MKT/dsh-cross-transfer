/**
 * 房间 Git 工作区同步服务（契约：.plan/room-git-workspace.md §3 / §4.2）。
 *
 * 职责：房主给房间配一个 http(s) Git 仓库，成员各自把宿主本机的一个工作区目录绑定到
 * 该房间；AI 回合结束时由宿主钩子触发「提交 + 按需推送」。
 *
 * 为什么单独成服务，而不是塞进 GitSyncService：
 * - GitSyncService 只回答「一个本地目录怎么提交/推送」，不认识房间、权限与成员视角。
 *   房间归属、脱敏投影、去抖与串行都是房间语义，混进去会让 git-sync 反向依赖 RoomService。
 * - 对外投影必须脱敏（token 绝不外流、remoteUrl 已剥离 userinfo、工作区路径只对本人与
 *   房主可见，§3），所以真实状态只留在这里的内存里，出门的永远是 RoomRepoStatus。
 *
 * 本文件只实现服务层；REST / WS / 客户端接线见 §4.4 / §4.5 / §5，不在这里。
 */
import { Service, Context } from '@deepseek-ai/cordis'
import * as Git from 'isomorphic-git'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'
import { RoomError, RoomService, maskDeviceId, type RoomMember } from './rooms.js'
import { GitSyncService } from './git-sync.js'
import { createTypedEmitter, TypedEmitter } from './typed-emitter.js'

// ---------------------------------------------------------------------------
// 对外形状（契约 §3，冻结：字段名/可选性/语义一律不得改动）
// ---------------------------------------------------------------------------

export interface RoomRepoAuthInput {
  /** 仅支持 token 形式（HTTPS Basic）。 */
  type: 'token'
  token: string
  /** 默认 'oauth2'（GitHub）或 'git'。 */
  username?: string
}

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

/** 对外投影：绝不包含 token、绝不包含未剥离 userinfo 的 URL。 */
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

export interface RoomGitConfig {
  enabled: boolean
  /** 自动同步的合并窗口（毫秒），默认 1500。 */
  debounceMs: number
  /** 单次 push 超时，默认 60000。 */
  pushTimeoutMs: number
  /** 每个房间最多保留的绑定数，默认 16。 */
  maxBindingsPerRoom: number
  /** 候选目录上限，默认 50。 */
  maxCandidates: number
}

/** roomGit 默认值（契约 §4.2 与 §4.6 的 schemastery 默认值必须一致）。 */
export const DEFAULT_ROOM_GIT_CONFIG: RoomGitConfig = {
  enabled: true,
  debounceMs: 1500,
  pushTimeoutMs: 60_000,
  maxBindingsPerRoom: 16,
  maxCandidates: 50
}

/** 本服务的事件表（自建 typed emitter，不覆盖 Service/Context 的 on/emit，§4.2）。 */
export interface RoomWorkspaceEvents {
  'status-changed': [roomId: string, status: RoomRepoStatus]
  'sync-finished': [roomId: string, deviceId: string, summary: SyncSummary]
}

// ---------------------------------------------------------------------------
// 内部状态（只在本文件可见，绝不直接出门）
// ---------------------------------------------------------------------------

/** 已校验归一化的仓库配置。remoteUrl 保证已剥离 userinfo，auth 只留在内存里（§3）。 */
interface StoredRepo {
  remoteUrl: string
  branch: string
  auth?: RoomRepoAuthInput
  autoCommit: boolean
  autoPush: boolean
  commitAuthorName: string
  commitAuthorEmail: string
  updatedAt: number
  /** 真 deviceId（投影时才脱敏）。 */
  updatedByDeviceId: string
}

/** 归一化结果：时间戳与操作者由 configureRepo 落库时补。 */
type NormalizedRepoConfig = Omit<StoredRepo, 'updatedAt' | 'updatedByDeviceId'>

/**
 * 一个设备的绑定（契约 §4.2 规则 3~5）。
 *
 * running / queued / dirty 三者合起来实现「按 roomId + deviceId 串行 + 运行期间只补跑一次」：
 * 同一绑定任何时刻只有一个 git 操作在跑，运行期间来的触发全部合并进同一个补跑。
 */
interface Binding {
  /** 真 deviceId。 */
  deviceId: string
  /** 规范化后的真实路径（realpath）。 */
  path: string
  /** ensureRepo 是否已按「当前仓库配置」跑过。 */
  repoReady: boolean
  lastSync?: SyncSummary
  /** 正在执行的同步；null = 空闲。 */
  running: Promise<SyncSummary> | null
  /** 运行期间排队的一次补跑；多个触发共用（规则 4）。 */
  queued: Promise<SyncSummary> | null
  /** 运行期间有触发进来 → 结束后补跑一次。 */
  dirty: boolean
  /** 去抖定时器（规则 5）。 */
  timer: ReturnType<typeof setTimeout> | null
  /** 去抖窗口内所有触发共用的 promise（规则 5：被合并的触发复用同一个 promise）。 */
  pending: Promise<SyncSummary> | null
  /** pending 的兑现函数；解绑/关房时用它兑现，避免调用方永远挂着。 */
  settle: ((summary: SyncSummary) => void) | null
}

interface RoomState {
  repo?: StoredRepo
  /** key = 真 deviceId（房间维度内唯一）。 */
  bindings: Map<string, Binding>
}

/**
 * 宿主事件总线的最小结构（契约 §4.2 attachHost）。
 *
 * 为什么不用 cordis 的 ctx.on 类型：'session/event' 由 dsh 宿主对 cordis Events 做模块增补，
 * 本仓库的 tsconfig 看不到那份增补，直接用 ctx.on 会编译失败。结构化读取既保留参数类型，
 * 又不会因为宿主版本差异而编译不过。
 */
interface HostSessionLike {
  id?: string
}

interface HostSessionEventLike {
  type?: string
  seq?: number
  data?: { turn?: number }
}

interface HostEventBusLike {
  on(name: string, listener: (session: HostSessionLike, event: HostSessionEventLike) => void): () => boolean
}

/** 分支名白名单（契约 §4.2 规则 2）。 */
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,128}$/
/** 提交信息里最多展示的文件数；超出部分写成 `…(+K)`（规则 4）。 */
const MAX_MESSAGE_FILES = 20
const DEFAULT_COMMIT_AUTHOR_NAME = 'dsh-cross-transfer'
const DEFAULT_COMMIT_AUTHOR_EMAIL = 'cross-transfer@dsh.local'
const DEFAULT_BRANCH = 'main'

/** git-sync 侧的仓库 id 约定：一个房间一个仓库（契约 §4.2 规则 3）。 */
function roomRepoId(roomId: string): string {
  return `room:${roomId}`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class RoomWorkspaceService extends Service {
  private readonly rooms: RoomService
  private readonly gitSync: GitSyncService
  private config: RoomGitConfig = { ...DEFAULT_ROOM_GIT_CONFIG }
  private states = new Map<string, RoomState>()
  private emitter = createTypedEmitter<RoomWorkspaceEvents>()

  constructor(ctx: Context, rooms: RoomService, gitSync: GitSyncService) {
    super(ctx, 'roomWorkspace')
    this.rooms = rooms
    this.gitSync = gitSync
  }

  // TypedEmitter methods
  on<K extends keyof RoomWorkspaceEvents>(event: K, listener: (...args: RoomWorkspaceEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof RoomWorkspaceEvents>(event: K, listener: (...args: RoomWorkspaceEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof RoomWorkspaceEvents>(event: K, ...args: RoomWorkspaceEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof RoomWorkspaceEvents>(event: K, listener: (...args: RoomWorkspaceEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  initialize(config: Partial<RoomGitConfig> = {}): void {
    // 逐项兜底而不是整体展开：index.ts 走 schemastery 一定有值，但直接调用（测试、
    // 将来的其它宿主）可能只给半个对象或脏值，脏值不该把默认值带坏。
    this.config = {
      enabled: typeof config.enabled === 'boolean' ? config.enabled : DEFAULT_ROOM_GIT_CONFIG.enabled,
      debounceMs: this.nonNegative(config.debounceMs, DEFAULT_ROOM_GIT_CONFIG.debounceMs),
      pushTimeoutMs: this.nonNegative(config.pushTimeoutMs, DEFAULT_ROOM_GIT_CONFIG.pushTimeoutMs),
      maxBindingsPerRoom: this.nonNegative(config.maxBindingsPerRoom, DEFAULT_ROOM_GIT_CONFIG.maxBindingsPerRoom),
      maxCandidates: this.nonNegative(config.maxCandidates, DEFAULT_ROOM_GIT_CONFIG.maxCandidates)
    }
    this.ctx.logger.info('[cross-transfer] Room workspace service initialized')
  }

  // -------------------------------------------------------------------------
  // 房主操作
  // -------------------------------------------------------------------------

  /**
   * 纯校验（契约 §4.2 规则 2）：不联网、不落盘，建房前先挡一次，
   * 免得建出一个「仓库配错了」的半成品房间。
   *
   * enabled=false 也在这里挡：否则带 repo 的建房会「先把房间建出来、再因 configureRepo
   * 回 forbidden」，留下一个配不上仓库的房间。开关判定同样是纯内存的，符合「纯校验」。
   */
  validateRepoConfig(input: RoomRepoConfigInput): void {
    this.assertEnabled()
    this.normalizeRepoConfig(input)
  }

  async configureRepo(roomId: string, actorDeviceId: string, input: RoomRepoConfigInput): Promise<RoomRepoStatus> {
    this.assertOwner(roomId, actorDeviceId)
    this.assertEnabled()

    // 校验先于任何状态改动：invalid-repo 时不能留下半配置的房间。
    const normalized = this.normalizeRepoConfig(input)
    const state = this.ensureState(roomId)
    const previous = state.repo
    state.repo = { ...normalized, updatedAt: Date.now(), updatedByDeviceId: actorDeviceId }

    // 远端/分支/凭据变了，旧绑定里的 origin 与 git-sync 记住的分支/凭据就过期了，
    // 必须重新绑定一次 ensureRepo 才敢同步（fail-closed，宁可让成员点一次「绑定」）。
    if (!previous || !sameRepoIdentity(previous, state.repo)) {
      for (const binding of state.bindings.values()) binding.repoReady = false
    }

    this.rooms.setRepoConfigured(roomId, true)
    const status = this.project(roomId, actorDeviceId)
    this.emit('status-changed', roomId, status)
    return status
  }

  async clearRepo(roomId: string, actorDeviceId: string): Promise<RoomRepoStatus> {
    this.assertOwner(roomId, actorDeviceId)
    this.assertEnabled()

    const state = this.states.get(roomId)
    if (state) {
      delete state.repo
      // 仓库没了，已绑定的工作区不再有可推送的 origin；房主重新配置后需要成员重新绑定。
      for (const binding of state.bindings.values()) binding.repoReady = false
    }

    this.rooms.setRepoConfigured(roomId, false)
    const status = this.project(roomId, actorDeviceId)
    this.emit('status-changed', roomId, status)
    return status
  }

  // -------------------------------------------------------------------------
  // 成员操作
  // -------------------------------------------------------------------------

  async bindWorkspace(roomId: string, deviceId: string, workspacePath: string): Promise<RoomRepoStatus> {
    this.assertMember(roomId, deviceId)
    this.assertEnabled()

    // 路径校验放在「房间是否配了仓库」之前：相对路径/不存在的目录是调用方自己的错误，
    // 报 invalid-workspace 比 invalid-repo 更能指出问题（契约 §4.2 规则 3）。
    const raw = typeof workspacePath === 'string' ? workspacePath.trim() : ''
    if (raw.length === 0 || !path.isAbsolute(raw)) {
      throw new RoomError('invalid-workspace', 'workspacePath must be an absolute path')
    }
    const stat = await fs.stat(raw).catch(() => undefined)
    if (!stat || !stat.isDirectory()) {
      throw new RoomError('invalid-workspace', 'workspacePath must be an existing directory')
    }
    // 规范化后再存：realpath 会解掉符号链接与 8.3 短名，回合结束时的 cwd 才比得上（规则 5）。
    const localPath = this.normalizePath(raw)

    const existingState = this.states.get(roomId)
    const repo = existingState?.repo
    if (!repo) throw new RoomError('invalid-repo', 'Room repository is not configured')

    const state = this.ensureState(roomId)
    const existing = state.bindings.get(deviceId)
    // 同设备重复绑定 = 更新，不占新名额（规则 3）。
    if (!existing && state.bindings.size >= this.config.maxBindingsPerRoom) {
      throw new RoomError('invalid-argument', 'too many bindings')
    }

    try {
      await this.gitSync.ensureRepo({
        repoId: roomRepoId(roomId),
        name: this.roomLabel(roomId, deviceId),
        localPath,
        remoteUrl: repo.remoteUrl,
        branch: repo.branch,
        auth: repo.auth
      })
    } catch (error) {
      throw new RoomError('invalid-workspace', `工作区无法初始化为 Git 仓库: ${errorText(error)}`)
    }

    if (existing) {
      // 换了目录就把上一次的同步结果清掉：它属于旧目录，留着会误导。
      if (existing.path !== localPath) existing.lastSync = undefined
      existing.path = localPath
      existing.repoReady = true
    } else {
      state.bindings.set(deviceId, {
        deviceId,
        path: localPath,
        repoReady: true,
        running: null,
        queued: null,
        dirty: false,
        timer: null,
        pending: null,
        settle: null
      })
    }

    const status = this.project(roomId, deviceId)
    this.emit('status-changed', roomId, status)
    return status
  }

  async unbindWorkspace(roomId: string, deviceId: string): Promise<RoomRepoStatus> {
    const state = this.states.get(roomId)
    const binding = state?.bindings.get(deviceId)
    // 契约 §4.2 规则 1 的「非成员 → not-a-member」与规则 6 的「踢人/退房后由 gateway 清理」
    // 在这里交汇：清理发生时设备已被 kickMember/leaveRoom 移出成员表，先判成员必然
    // not-a-member，绑定（含内存里的 token）会一直留到进程关闭。所以只有「既不是成员、
    // 也没有本房绑定」才算越权调用；已离开的成员留下的绑定必须允许清掉。
    if (!this.rooms.isMember(roomId, deviceId) && !binding) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
    // enabled=false 时成员的解绑按规则 2 拒绝；但清理路径不再受开关影响，
    // 否则宿主中途关掉开关会让被踢成员的绑定永远清不掉。
    if (this.rooms.isMember(roomId, deviceId)) this.assertEnabled()

    if (state && binding) {
      this.cancelPending(binding, '绑定已解除')
      state.bindings.delete(deviceId)
      this.emit('status-changed', roomId, this.project(roomId, deviceId))
    }
    // 未绑定也返回状态：解绑是幂等动作，不该报错。
    return this.project(roomId, deviceId)
  }

  /**
   * 手动/自动同步。手动（默认）永远提交；自动触发在 autoCommit=false 时直接跳过（规则 4）。
   *
   * 失败不抛（结果里带 ok=false，规则 4）；只有「绑定已不存在」这类调用方错误才抛
   * sync-failed —— 契约 §4.3 把这个码留给这一层。
   */
  async sync(roomId: string, deviceId: string, trigger: 'auto' | 'manual' = 'manual'): Promise<SyncSummary> {
    this.assertMember(roomId, deviceId)
    this.assertEnabled()

    const state = this.states.get(roomId)
    const binding = state?.bindings.get(deviceId)
    if (!binding) throw new RoomError('sync-failed', 'Workspace is not bound for this device')
    const repo = state?.repo
    if (!repo) throw new RoomError('invalid-repo', 'Room repository is not configured')
    if (!binding.repoReady) {
      throw new RoomError('invalid-workspace', 'Workspace is not initialized for the current repository, rebind it first')
    }
    if (trigger === 'auto' && !repo.autoCommit) {
      // 跳过不写 lastSync、不发 sync-finished：没有发生任何同步，写进去会让「上次同步」
      // 显示一次并不存在的同步（规则 4 的「直接跳过」）。
      return { at: Date.now(), ok: true, trigger, committed: 0, pushed: false }
    }

    return this.enqueueSync(roomId, binding, trigger)
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  status(roomId: string, viewerDeviceId: string): RoomRepoStatus {
    this.assertMember(roomId, viewerDeviceId)
    return this.project(roomId, viewerDeviceId)
  }

  /**
   * 候选工作区目录（契约 §4.2 规则 7）。
   *
   * 只是「省一次手输」的便利功能：宿主服务形状不确定（workspaceRegistry 尤其），
   * 任何依赖缺失或形状不符都静默跳过，绝不抛。
   */
  async candidates(): Promise<string[]> {
    const out: string[] = []
    const seen = new Set<string>()

    const collect = (value: unknown): void => {
      if (out.length >= this.config.maxCandidates) return
      if (typeof value !== 'string' || value.length === 0) return
      const candidate = this.normalizePath(value)
      const key = this.pathKey(candidate)
      if (seen.has(key)) return
      try {
        if (!fsSync.statSync(candidate).isDirectory()) return
      } catch {
        return
      }
      seen.add(key)
      out.push(candidate)
    }

    try {
      const sessions = this.ctx.get('sessions')?.list?.()
      if (Array.isArray(sessions)) {
        for (const session of sessions) {
          try {
            collect(session?.header?.cwd)
          } catch {}
        }
      }
    } catch {}

    try {
      const entries = this.ctx.get('workspaceRegistry')?.list?.()
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          try {
            // 形状不确定：path 是文档里的字段，cwd 是兜底。
            collect(entry?.path ?? entry?.cwd)
          } catch {}
        }
      }
    } catch {}

    return out
  }

  // -------------------------------------------------------------------------
  // 宿主钩子
  // -------------------------------------------------------------------------

  /**
   * cwd 命中绑定 → 去抖后提交+推送（契约 §4.2 规则 5）。
   *
   * 返回本次触发的同步结果：被去抖合并进同一窗口的触发拿到的是同一个 promise，
   * 因此可能返回重复的 SyncSummary；没有任何绑定命中时返回 []。
   */
  async handleWorkspaceChanges(cwd: string, summary: { files: { path: string }[]; total: number }): Promise<SyncSummary[]> {
    // 没有变更就没有可提交的东西，也不必白白开一个去抖窗口。
    if (!summary || typeof summary.total !== 'number' || summary.total <= 0) return []
    if (typeof cwd !== 'string' || cwd.length === 0) return []

    const target = this.pathKey(this.normalizePath(cwd))
    const triggers: Promise<SyncSummary>[] = []
    for (const [roomId, state] of this.states) {
      const repo = state.repo
      // autoCommit=false 的房间：自动触发直接跳过（规则 4），连窗口都不开。
      if (!repo || !repo.autoCommit) continue
      for (const binding of state.bindings.values()) {
        if (this.pathKey(binding.path) !== target) continue
        if (!binding.repoReady) continue
        // 绑定可能残留到设备离开房间之后（踢人/退房与解绑不是原子的）：先判成员资格，
        // 免得触发一个注定失败的同步，也免得把改动推到别人已经退出的房间。
        if (!this.rooms.isMember(roomId, binding.deviceId)) continue
        triggers.push(this.scheduleAutoSync(roomId, binding))
      }
    }
    if (triggers.length === 0) return []
    return Promise.all(triggers)
  }

  /**
   * 订阅 dsh 的 'session/event'，读 workspaceChanges.summary（契约 §4.2 attachHost）。
   *
   * 依赖缺失时只记一条 info 并退化成空函数：插件其余功能必须照常可用，
   * 绝不能因为宿主没有这个服务就抛。返回退订函数。
   */
  attachHost(): () => void {
    let available = false
    try {
      const service = this.ctx.get('workspaceChanges')
      available = Boolean(service && typeof service.summary === 'function')
    } catch {
      available = false
    }
    if (!available) {
      this.ctx.logger.info('[cross-transfer] workspaceChanges service is unavailable; room git auto-sync hook disabled')
      return () => {}
    }

    let off: (() => boolean) | undefined
    try {
      const bus = this.ctx as unknown as HostEventBusLike
      off = bus.on('session/event', (session, event) => this.onSessionEvent(session, event))
    } catch (error) {
      this.ctx.logger.info(`[cross-transfer] failed to subscribe session/event; room git auto-sync hook disabled: ${errorText(error)}`)
      return () => {}
    }

    return () => {
      try {
        off?.()
      } catch {}
    }
  }

  /**
   * 房间关闭：清掉该房配置与绑定并清定时器（契约 §4.2 规则 6）。
   *
   * 由 RoomGateway 在 'room-closed' 事件里调用（含房主关房、房主离开、空闲回收）。
   * 不清的话内存里的明文 token 会一直留到进程退出。被踢/退房走的是 unbindWorkspace，
   * 那条路径对「已不在房间、但还留着本房绑定」的设备是放行的。
   */
  onRoomClosed(roomId: string): void {
    const state = this.states.get(roomId)
    if (state) {
      for (const binding of state.bindings.values()) this.cancelPending(binding, '房间已关闭')
      this.states.delete(roomId)
    }
    // 顺带把 git-sync 侧的登记也注销：否则明文 token 会一直留在 git-sync 的内存里。
    void this.gitSync.unregisterRepo(roomRepoId(roomId))
    // 房间还在（关房链路里房间可能已先被移除）时同步公开投影的布尔位。
    try {
      this.rooms.setRepoConfigured(roomId, false)
    } catch {}
  }

  shutdown(): void {
    for (const state of this.states.values()) {
      for (const binding of state.bindings.values()) this.cancelPending(binding, '服务已关闭')
    }
    this.states.clear()
    this.ctx.logger.info('[cross-transfer] Room workspace service shut down')
  }

  // -------------------------------------------------------------------------
  // 同步执行：串行 + 去抖 + 补跑
  // -------------------------------------------------------------------------

  /**
   * 串行与合并（契约 §4.2 规则 4）：
   * - 同一绑定任何时刻只跑一次 git 操作；
   * - 运行期间来的触发只置脏，结束后补跑一次，且所有被合并的触发复用同一个 promise。
   */
  private enqueueSync(roomId: string, binding: Binding, trigger: 'auto' | 'manual'): Promise<SyncSummary> {
    if (binding.running) {
      binding.dirty = true
      if (!binding.queued) {
        const runNext = (): Promise<SyncSummary> => {
          binding.queued = null
          if (!binding.dirty) return Promise.resolve(binding.lastSync ?? this.skippedSummary(trigger))
          binding.dirty = false
          return this.startRun(roomId, binding, trigger)
        }
        binding.queued = binding.running.then(runNext, runNext)
      }
      return binding.queued
    }
    return this.startRun(roomId, binding, trigger)
  }

  private startRun(roomId: string, binding: Binding, trigger: 'auto' | 'manual'): Promise<SyncSummary> {
    const run = this.performSync(roomId, binding, trigger)
    binding.running = run
    const clear = (): void => {
      if (binding.running === run) binding.running = null
    }
    run.then(clear, clear)
    return run
  }

  private async performSync(roomId: string, binding: Binding, trigger: 'auto' | 'manual'): Promise<SyncSummary> {
    const state = this.states.get(roomId)
    const repo = state?.repo
    // 排队期间可能已经被解绑/关房：不再动 git，finishSync 也不会广播（规则 4）。
    if (!repo || state?.bindings.get(binding.deviceId) !== binding) {
      return { at: Date.now(), ok: false, trigger, committed: 0, pushed: false, error: '绑定已失效' }
    }
    if (trigger === 'auto' && !repo.autoCommit) return this.skippedSummary(trigger)

    const localPath = binding.path
    let changed = 0
    try {
      changed = await this.countChanges(localPath)
    } catch {
      // 数不出来不影响提交本身（§4.1 的 commitAndPush 会再数一遍），只是提交信息里的数字保守为 0。
      changed = 0
    }

    let result: SyncSummary
    try {
      const outcome = await this.gitSync.commitAndPush(roomRepoId(roomId), {
        message: this.buildCommitMessage(this.roomLabel(roomId, binding.deviceId), changed),
        authorName: repo.commitAuthorName,
        authorEmail: repo.commitAuthorEmail,
        // autoPush=false 时只提交不推送（规则 4）。
        push: repo.autoPush,
        // 契约 §4.2 的 pushTimeoutMs 是「单次 push 超时」；§4.1 只有一个整体超时旋钮，就用它。
        timeoutMs: this.config.pushTimeoutMs
      })
      result = {
        at: Date.now(),
        // 契约 §6 要求 push 失败时 ok=false。§4.1 的 commitAndPush 此时仍返回 ok=true 只带 error，
        // 所以以 error 是否为空为准（这正是它接口注释声明的 ok 语义）。
        ok: outcome.ok && outcome.error === undefined,
        trigger,
        committed: outcome.committed,
        commitOid: outcome.commitOid,
        pushed: outcome.pushed,
        error: outcome.error
      }
    } catch (error) {
      // commitAndPush 按契约不抛；真抛了也只落在结果里，失败必须可见（规则 4）。
      result = { at: Date.now(), ok: false, trigger, committed: 0, pushed: false, error: errorText(error).slice(0, 500) }
    }
    return this.finishSync(roomId, binding, result)
  }

  private finishSync(roomId: string, binding: Binding, result: SyncSummary): SyncSummary {
    binding.lastSync = result
    const state = this.states.get(roomId)
    // 绑定已被解绑/房间已关闭时只更新（已脱离的）对象，不广播：广播一个不存在的绑定会误导客户端。
    if (state && state.bindings.get(binding.deviceId) === binding) {
      this.emit('sync-finished', roomId, binding.deviceId, result)
    }
    return result
  }

  private scheduleAutoSync(roomId: string, binding: Binding): Promise<SyncSummary> {
    // 已有窗口：只把窗口往后推，并复用同一个 promise（规则 5：被合并的触发复用同一个 promise）。
    if (binding.pending) {
      if (binding.timer) clearTimeout(binding.timer)
      binding.timer = setTimeout(() => this.flushAutoSync(roomId, binding), this.config.debounceMs)
      return binding.pending
    }

    let settle!: (summary: SyncSummary) => void
    const pending = new Promise<SyncSummary>(resolve => {
      settle = resolve
    })
    binding.pending = pending
    binding.settle = settle
    binding.timer = setTimeout(() => this.flushAutoSync(roomId, binding), this.config.debounceMs)
    return pending
  }

  private flushAutoSync(roomId: string, binding: Binding): void {
    const settle = binding.settle
    binding.timer = null
    binding.pending = null
    binding.settle = null
    if (!settle) return
    this.enqueueSync(roomId, binding, 'auto').then(settle, error => {
      settle({ at: Date.now(), ok: false, trigger: 'auto', committed: 0, pushed: false, error: errorText(error) })
    })
  }

  /**
   * 清掉去抖定时器并兑现等待者。
   *
   * 必须兑现：handleWorkspaceChanges 的 Promise.all 会一直挂着，否则关房/解绑就成了
   * 「调用方永远等不到结果」。
   */
  private cancelPending(binding: Binding, reason: string): void {
    if (binding.timer) {
      clearTimeout(binding.timer)
      binding.timer = null
    }
    const settle = binding.settle
    binding.pending = null
    binding.settle = null
    settle?.({ at: Date.now(), ok: false, trigger: 'auto', committed: 0, pushed: false, error: reason })
  }

  // -------------------------------------------------------------------------
  // 校验与投影
  // -------------------------------------------------------------------------

  /**
   * 归一化 + 校验（契约 §4.2 规则 2）。纯内存：不联网、不碰磁盘。
   */
  private normalizeRepoConfig(input: RoomRepoConfigInput): NormalizedRepoConfig {
    const rawUrl = typeof input?.remoteUrl === 'string' ? input.remoteUrl.trim() : ''
    if (rawUrl.length === 0) throw new RoomError('invalid-repo', 'remoteUrl is required')

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      throw new RoomError('invalid-repo', 'remoteUrl is not a valid URL')
    }
    // isomorphic-git 只实现了 http(s) 传输（契约 §2），别的协议连试都不必试。
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new RoomError('invalid-repo', 'Only http:// and https:// remotes are supported')
    }
    if (url.hostname.length === 0) throw new RoomError('invalid-repo', 'remoteUrl has no host')

    const embeddedUser = url.username ? decodeURIComponent(url.username) : ''
    const embeddedPass = url.password ? decodeURIComponent(url.password) : ''
    const hasEmbedded = embeddedUser.length > 0 || embeddedPass.length > 0

    let auth: RoomRepoAuthInput | undefined
    if (hasEmbedded) {
      // 同时给 auth 与内嵌 userinfo 属于「说不清用哪份凭据」，一律拒绝（规则 2）。
      if (input.auth) throw new RoomError('invalid-repo', 'auth and embedded userinfo cannot be used together')
      // 两种常见写法：https://user:token@host（user 是用户名）与 https://token@host（用户名位置放令牌）。
      auth = {
        type: 'token',
        token: embeddedPass || embeddedUser,
        username: embeddedPass ? embeddedUser || undefined : undefined
      }
    } else if (input.auth) {
      auth = this.normalizeAuth(input.auth)
    }

    // 剥离 userinfo：存储值与对外投影都绝不含凭据（§3）。toString() 顺带做一次规范化。
    url.username = ''
    url.password = ''

    const branch = input.branch === undefined || input.branch === null ? DEFAULT_BRANCH : input.branch
    if (
      typeof branch !== 'string' ||
      !BRANCH_PATTERN.test(branch) ||
      // '..' 与开头 '-' 都能通过上面的字符集，必须单独挡（规则 2）。
      branch.includes('..') ||
      branch.startsWith('-')
    ) {
      throw new RoomError('invalid-repo', 'branch is not a valid git branch name')
    }

    return {
      remoteUrl: url.toString(),
      branch,
      auth,
      autoCommit: input.autoCommit !== false,
      autoPush: input.autoPush !== false,
      commitAuthorName: this.nonEmpty(input.commitAuthorName, DEFAULT_COMMIT_AUTHOR_NAME),
      commitAuthorEmail: this.nonEmpty(input.commitAuthorEmail, DEFAULT_COMMIT_AUTHOR_EMAIL)
    }
  }

  private normalizeAuth(input: RoomRepoAuthInput): RoomRepoAuthInput {
    if (!input || input.type !== 'token' || typeof input.token !== 'string' || input.token.length === 0) {
      throw new RoomError('invalid-repo', 'auth must be a token credential')
    }
    const username = typeof input.username === 'string' && input.username.length > 0 ? input.username : undefined
    return { type: 'token', token: input.token, username }
  }

  /**
   * 按视角投影（§3）：token 永不出现；remoteUrl 已剥离 userinfo；工作区路径只对
   * 绑定者本人与房主可见。
   *
   * 成员行来自房间成员表而不是绑定表：WorkspaceBindingStatus.bound 与 §5.2 的
   * 「每个成员一行（已绑定/未绑定）」都要求未绑定的成员也出现。已不在房间的残留绑定
   * 追加在末尾，否则它既看不见又清不掉。
   */
  private project(roomId: string, viewerDeviceId: string): RoomRepoStatus {
    const state = this.states.get(roomId)
    const repo = state?.repo
    const viewerIsOwner = this.rooms.isOwner(roomId, viewerDeviceId)

    let members: RoomMember[] | undefined
    try {
      members = this.rooms.getMembers(roomId, viewerDeviceId)
    } catch {
      members = undefined
    }

    const bindings: WorkspaceBindingStatus[] = []
    const projected = new Set<string>()
    if (members) {
      for (const member of members) {
        // getMembers 只给脱敏 id，只能按脱敏值回找绑定；同房 ≤16 个成员，碰撞概率可忽略。
        let binding: Binding | undefined
        if (state) {
          for (const candidate of state.bindings.values()) {
            if (maskDeviceId(candidate.deviceId) === member.deviceId) {
              binding = candidate
              break
            }
          }
        }
        if (binding) projected.add(binding.deviceId)
        bindings.push({
          deviceId: member.deviceId,
          deviceName: member.deviceName,
          bound: Boolean(binding),
          workspacePath: binding && (binding.deviceId === viewerDeviceId || viewerIsOwner) ? binding.path : undefined,
          repoReady: binding?.repoReady,
          lastSync: binding?.lastSync
        })
      }
    }
    if (state) {
      for (const binding of state.bindings.values()) {
        if (projected.has(binding.deviceId)) continue
        const masked = maskDeviceId(binding.deviceId)
        bindings.push({
          deviceId: masked,
          deviceName: masked,
          bound: true,
          workspacePath: binding.deviceId === viewerDeviceId || viewerIsOwner ? binding.path : undefined,
          repoReady: binding.repoReady,
          lastSync: binding.lastSync
        })
      }
    }

    return {
      roomId,
      configured: Boolean(repo),
      remoteUrl: repo ? this.sanitizeRemoteUrl(repo.remoteUrl) : undefined,
      branch: repo?.branch,
      authConfigured: Boolean(repo?.auth),
      autoCommit: repo?.autoCommit ?? true,
      autoPush: repo?.autoPush ?? true,
      updatedAt: repo?.updatedAt,
      updatedByDeviceId: repo ? maskDeviceId(repo.updatedByDeviceId) : undefined,
      bindings
    }
  }

  /** 双保险：存储值本来就已剥离，这里再剥一次，任何路径都别想把凭据送出去（§3）。 */
  private sanitizeRemoteUrl(value: string): string {
    try {
      const url = new URL(value)
      url.username = ''
      url.password = ''
      return url.toString()
    } catch {
      return value.replace(/\/\/[^/@]*@/, '//')
    }
  }

  // -------------------------------------------------------------------------
  // 杂项
  // -------------------------------------------------------------------------

  private assertMember(roomId: string, deviceId: string): void {
    if (!this.rooms.isMember(roomId, deviceId)) {
      throw new RoomError('not-a-member', 'Not a member of this room')
    }
  }

  private assertOwner(roomId: string, deviceId: string): void {
    this.assertMember(roomId, deviceId)
    if (!this.rooms.isOwner(roomId, deviceId)) {
      throw new RoomError('forbidden', 'Only the room owner can configure the room repository')
    }
  }

  /** roomGit.enabled === false 时所有写操作一律 forbidden（规则 2 最后一条）。 */
  private assertEnabled(): void {
    if (!this.config.enabled) throw new RoomError('forbidden', 'Room git workspace sync is disabled')
  }

  private ensureState(roomId: string): RoomState {
    let state = this.states.get(roomId)
    if (!state) {
      state = { bindings: new Map() }
      this.states.set(roomId, state)
    }
    return state
  }

  private roomLabel(roomId: string, viewerDeviceId: string): string {
    try {
      const info = this.rooms.getRoomInfo(roomId, viewerDeviceId)
      if (info && typeof info.name === 'string' && info.name.length > 0) return info.name
    } catch {}
    return roomId
  }

  /**
   * 提交信息（契约 §4.2 规则 4）：`chore(cross-transfer): <房间名或 roomId> 自动同步 <N> 个文件`。
   *
   * N 超过 20 时只展示 20 并在末尾附 `…(+K)`（K = N - 20）：契约里 20 这个阈值的作用就是
   * 截断，`…(+K)` 是「还有 K 个未列出」的惯用写法；基础模板本身保持逐字不变，多出来的
   * 标记是「附」在整条信息末尾的。
   */
  private buildCommitMessage(label: string, count: number): string {
    const shown = Math.min(count, MAX_MESSAGE_FILES)
    const base = `chore(cross-transfer): ${label} 自动同步 ${shown} 个文件`
    return count > MAX_MESSAGE_FILES ? `${base}…(+${count - MAX_MESSAGE_FILES})` : base
  }

  /**
   * 数一遍「本次会被提交的文件数」，只为了把 N 写进提交信息（规则 4）。
   *
   * 为什么在这里数：§4.1 的 commitAndPush 只在提交之后才返回计数，签名已冻结，
   * 提交前拿不到那个数字。判定规则与 §4.1 完全一致（workdir===2 新增/修改，
   * head===1 且 workdir===0 删除），所以正常情况下两个数字相等。
   */
  private async countChanges(localPath: string): Promise<number> {
    const matrix = await Git.statusMatrix({ fs: fsSync, dir: localPath })
    let count = 0
    for (const row of matrix) {
      const head = row[1]
      const workdir = row[2]
      if (workdir === 2 || (head === 1 && workdir === 0)) count++
    }
    return count
  }

  /** 事件派发是同步的：这里绝不能 await，否则会拖住整条事件链。 */
  private onSessionEvent(session: HostSessionLike, event: HostSessionEventLike): void {
    try {
      if (!event || event.type !== 'workspace/changes') return
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || sessionId.length === 0) return
      if (typeof event.seq !== 'number') return
      const summary = this.ctx.get('workspaceChanges')?.summary(sessionId, event.seq)
      if (!summary || typeof summary.cwd !== 'string' || summary.cwd.length === 0) return
      if (typeof summary.total !== 'number' || summary.total <= 0) return
      void this.handleWorkspaceChanges(summary.cwd, {
        files: Array.isArray(summary.files) ? summary.files : [],
        total: summary.total
      }).catch(() => {})
    } catch (error) {
      this.ctx.logger.warn(`[cross-transfer] room git auto-sync hook failed: ${errorText(error)}`)
    }
  }

  /**
   * 路径规范化（规则 3）：realpathSync.native 会解掉符号链接、统一盘符大小写与 8.3 短名，
   * 两次绑定同一个目录、以及回合结束时的 cwd 才能对得上。
   */
  private normalizePath(input: string): string {
    try {
      return fsSync.realpathSync.native(input)
    } catch {
      // 路径不存在（或没权限）时退化为纯字符串解析；调用方之后还会做存在性检查。
      return path.resolve(input)
    }
  }

  /** Windows 文件系统大小写不敏感（规则 3）：比较键统一小写才不会漏匹配。 */
  private pathKey(value: string): string {
    return process.platform === 'win32' ? value.toLowerCase() : value
  }

  private nonNegative(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
  }

  private nonEmpty(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.length > 0 ? value : fallback
  }

  private skippedSummary(trigger: 'auto' | 'manual'): SyncSummary {
    return { at: Date.now(), ok: true, trigger, committed: 0, pushed: false }
  }
}

/** 仓库身份是否未变：远端/分支/凭据任一变化都要让绑定重新 ensureRepo。 */
function sameRepoIdentity(a: StoredRepo, b: StoredRepo): boolean {
  return (
    a.remoteUrl === b.remoteUrl &&
    a.branch === b.branch &&
    a.auth?.token === b.auth?.token &&
    a.auth?.username === b.auth?.username
  )
}
