import { Service, Context } from '@deepseek-ai/cordis'
import { createTypedEmitter, TypedEmitter } from './typed-emitter.js'
import * as Git from 'isomorphic-git'
import http from 'isomorphic-git/http/node'
import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as path from 'path'

export interface RepoConfig {
  repoId: string
  name: string
  localPath: string
  remoteUrl: string
  branch: string
  auth?: {
    type: 'token' | 'ssh'
    token?: string
    username?: string
    sshKeyPath?: string
    passphrase?: string
  }
  autoSync?: boolean
  syncInterval?: number
}

export interface SyncOptions {
  operation: 'fetch' | 'pull' | 'push' | 'status'
  remote?: string
  branch?: string
  force?: boolean
}

export interface SyncResult {
  success: boolean
  operation: string
  repoId: string
  output?: string
  error?: string
  conflicts?: string[]
  filesChanged?: number
  commitsAhead?: number
  commitsBehind?: number
}

export interface FileStatus {
  filepath: string
  status: 'unmodified' | 'modified' | 'added' | 'deleted' | 'renamed' | 'conflicted'
  staged: boolean
}

/**
 * 房间工作区仓库的初始化入参（契约 §4.1）。
 *
 * auth 复用 RepoConfig['auth'] 而不是从 room-workspace.ts 引 RoomRepoAuthInput：
 * 那会形成 rooms → room-workspace → git-sync → room-workspace 的循环依赖。
 * 形状上两者本来就一致（token + 可选 username），复用即可。
 */
export interface EnsureRepoInput {
  repoId: string
  name: string
  localPath: string
  remoteUrl: string
  branch: string
  auth?: RepoConfig['auth']
}

/**
 * 一次「提交 + 按需推送」的结果（契约 §4.1）。
 *
 * ok 表示「提交成功且（未要求 push 或 push 成功）」。任何失败都不抛，
 * 只把截断后的原因放进 error，让调用方能原样显示给用户。
 */
export interface CommitPushResult {
  ok: boolean
  /** 本次实际 stage 的文件数（add + remove）；无变化时为 0 */
  committed: number
  commitOid?: string
  pushed: boolean
  error?: string
}

export interface GitSyncEvents {
  'sync-started': [repoId: string, operation: string]
  'sync-progress': [repoId: string, progress: { phase: string; loaded: number; total: number }]
  'sync-complete': [result: SyncResult]
  'sync-failed': [repoId: string, error: Error, operation: string]
  'conflict-detected': [repoId: string, conflicts: string[]]
  'repo-registered': [config: RepoConfig]
  'repo-unregistered': [repoId: string]
  'auto-sync-triggered': [repoId: string]
}

/**
 * Map one isomorphic-git StatusRow onto the reported file status.
 *
 * Both 0/x and x/0 rows mean "changed on one side only", and the stage column
 * distinguishes "staged" (1) from "conflicted" (2 and 3) — stage 2 is the
 * merge-stage entry and stage 3 is a staging entry that differs from the work
 * tree, which is exactly a conflict left for a human.
 */
function classifyStatus(head: 0 | 1, workdir: 0 | 1 | 2, stage: 0 | 1 | 2 | 3): FileStatus['status'] {
  if (stage === 2 || stage === 3) return 'conflicted'
  if (head === 1 && workdir === 0) return 'deleted'
  if (head === 0 && workdir > 0) return 'added'
  if (head === 1 && workdir === 2) return 'modified'
  return 'unmodified'
}

export class GitSyncService extends Service {
  private repos = new Map<string, RepoConfig>()
  private syncIntervals = new Map<string, NodeJS.Timeout>()
  private fsPromises = fs
  private emitter = createTypedEmitter<GitSyncEvents>()

  constructor(ctx: Context) {
    super(ctx, 'gitSync')
  }

  // TypedEmitter methods
  on<K extends keyof GitSyncEvents>(event: K, listener: (...args: GitSyncEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof GitSyncEvents>(event: K, listener: (...args: GitSyncEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof GitSyncEvents>(event: K, ...args: GitSyncEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof GitSyncEvents>(event: K, listener: (...args: GitSyncEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  initialize(): void {
    this.ctx.logger.info('[cross-transfer] Git sync service initialized')
  }

  async registerRepo(config: Omit<RepoConfig, 'repoId'> & { repoId?: string }): Promise<RepoConfig> {
    const repoId = config.repoId || this.generateRepoId()

    // Verify local path exists or create it
    try {
      await this.fsPromises.access(config.localPath)
    } catch {
      await this.fsPromises.mkdir(config.localPath, { recursive: true })
      // Initialize git repo
      await Git.init({ fs: fsSync, dir: config.localPath })
    }

    // Check if it's a git repo
    const isRepo = await Git.statusMatrix({ fs: fsSync, dir: config.localPath }).then(() => true).catch(() => false)
    if (!isRepo) {
      await Git.init({ fs: fsSync, dir: config.localPath })
    }

    // Add remote if not exists
    try {
      await Git.addRemote({
        fs: fsSync,
        dir: config.localPath,
        remote: 'origin',
        url: config.remoteUrl
      })
    } catch {
      // Remote might already exist, update URL
      await Git.setConfig({
        fs: fsSync,
        dir: config.localPath,
        path: 'remote.origin.url',
        value: config.remoteUrl
      })
    }

    // Configure auth
    if (config.auth) {
      await this.configureAuth(config.localPath, config.auth)
    }

    const repoConfig: RepoConfig = {
      repoId,
      name: config.name,
      localPath: config.localPath,
      remoteUrl: config.remoteUrl,
      branch: config.branch,
      auth: config.auth,
      autoSync: config.autoSync || false,
      syncInterval: config.syncInterval || 30000
    }

    this.repos.set(repoId, repoConfig)

    // Setup auto-sync if enabled
    if (repoConfig.autoSync) {
      this.startAutoSync(repoId)
    }

    this.emit('repo-registered', repoConfig)
    this.ctx.logger.info(`[cross-transfer] Git repo registered: ${config.name} (${repoId})`)

    return repoConfig
  }

  async unregisterRepo(repoId: string): Promise<boolean> {
    const repo = this.repos.get(repoId)
    if (!repo) return false

    this.stopAutoSync(repoId)
    this.repos.delete(repoId)
    this.emit('repo-unregistered', repoId)
    return true
  }

  getRepos(): RepoConfig[] {
    return Array.from(this.repos.values())
  }

  getRepo(repoId: string): RepoConfig | undefined {
    return this.repos.get(repoId)
  }

  /**
   * 把宿主工作区目录登记成房间仓库（契约 §4.1 / §4.2 规则 3）。
   *
   * 与 registerRepo 的区别（都是刻意的）：
   * - 目录必须已存在且是目录，**不 mkdir**——成员绑定的是自己机器上已有的
   *   工作区，替他造目录既越权又可能造到错误位置。
   * - 绝不写 credential.helper。旧 configureAuth 会把明文 token 写进
   *   .git/config，任何能读工作区的人都能拿到；新路径只让 auth 走回调。
   */
  async ensureRepo(input: EnsureRepoInput): Promise<RepoConfig> {
    const stat = await fs.stat(input.localPath).catch(() => undefined)
    if (!stat || !stat.isDirectory()) {
      throw new Error(`localPath is not a directory: ${input.localPath}`)
    }

    // 不是 git 仓库（含目录里已有 .git 之外的普通文件）则 init。
    const isRepo = await Git.statusMatrix({ fs: fsSync, dir: input.localPath })
      .then(() => true)
      .catch(() => false)
    if (!isRepo) {
      // 必须把配置的分支传给 init：isomorphic-git 默认建 master，而房间仓库的默认分支是
      // main（§4.2 规则 2）。不传的话本地是 refs/heads/master，commitAndPush 固定推
      // repo.branch，push 会直接 NotFoundError: Could not find main。
      await Git.init({ fs: fsSync, dir: input.localPath, defaultBranch: input.branch })
    }

    // origin 已存在时 addRemote 会因 "remote already exists" 失败，
    // 用 setConfig 直接改 remote.origin.url 更稳，且不碰其余 config。
    await Git.setConfig({
      fs: fsSync,
      dir: input.localPath,
      path: 'remote.origin.url',
      value: input.remoteUrl
    })

    const repoConfig: RepoConfig = {
      repoId: input.repoId,
      name: input.name,
      localPath: input.localPath,
      remoteUrl: input.remoteUrl,
      branch: input.branch,
      auth: input.auth,
      autoSync: false,
      syncInterval: 30000
    }

    this.repos.set(input.repoId, repoConfig)

    this.emit('repo-registered', repoConfig)
    this.ctx.logger.info(`[cross-transfer] Room workspace repo registered: ${input.name} (${input.repoId})`)

    return repoConfig
  }

  /**
   * 暂存工作区全部改动（新增/修改/删除）→ 有变化才提交 → 按需推送（契约 §4.1）。
   *
   * 全程不抛：repo 缺失、提交失败、push 失败、超时都变成返回值里的 error。
   * 也不发 sync-started/sync-complete/sync-failed——那些事件属于手动 syncRepo
   * 的既有契约，这里的调用方是回合结束钩子，高频且无需逐次进度播报。
   */
  async commitAndPush(
    repoId: string,
    options: { message: string; authorName: string; authorEmail: string; push: boolean; timeoutMs?: number }
  ): Promise<CommitPushResult> {
    const repo = this.repos.get(repoId)
    if (!repo) {
      return { ok: false, committed: 0, pushed: false, error: `Repo not found: ${repoId}` }
    }

    const work = async (): Promise<CommitPushResult> => {
      // StatusRow = [filepath, HeadStatus (0|1), WorkdirStatus (0|1|2), StageStatus]
      const statusMatrix = await Git.statusMatrix({ fs: fsSync, dir: repo.localPath })

      const toAdd: string[] = []
      const toRemove: string[] = []
      for (const row of statusMatrix) {
        const filepath = row[0]
        const head = row[1]
        const workdir = row[2]
        if (workdir === 2) {
          // 新增或修改：一律 stage。
          if (filepath) toAdd.push(filepath)
        } else if (head === 1 && workdir === 0) {
          // 文件被删除：stage 删除。
          if (filepath) toRemove.push(filepath)
        }
        // head===1 && workdir===1、head===0 && workdir===0 与 head===0 && workdir===1
        // 都视为未变化（后者只说明内容相同，stage 位不参与提交语义）。
      }

      // 同一文件理论上只会落在其中一个桶；去重只为让 committed 计数与真实
      // stage 动作一一对应。
      const added = toAdd.filter(filepath => !toRemove.includes(filepath))
      const removed = toRemove

      const committed = added.length + removed.length
      let commitOid: string | undefined
      if (committed > 0) {
        if (added.length > 0) {
          await Git.add({ fs: fsSync, dir: repo.localPath, filepath: added })
        }
        if (removed.length > 0) {
          await Git.remove({ fs: fsSync, dir: repo.localPath, filepath: removed })
        }
        commitOid = await Git.commit({
          fs: fsSync,
          dir: repo.localPath,
          message: options.message,
          author: { name: options.authorName, email: options.authorEmail },
          committer: { name: options.authorName, email: options.authorEmail }
        })
      }

      let pushed = false
      let error: string | undefined
      if (options.push && (committed > 0 || (await this.hasLocalBranch(repo)))) {
        try {
          await Git.push({
            fs: fsSync,
            dir: repo.localPath,
            remote: 'origin',
            ref: repo.branch,
            http: this.getHttpClient(repo),
            onAuth: this.getAuthCallback(repo)
          })
          pushed = true
        } catch (pushError) {
          // push 失败只记录，不抛：提交已经落盘，用户仍可手动重试。
          const message = pushError instanceof Error ? pushError.message : String(pushError)
          error = message.slice(0, 500)
        }
      }

      // ok 的语义就是接口注释里那句「提交成功且（未要求 push 或 push 成功）」：
      // 只要没有 error 就是成功。调用方（房间工作区）据此把 push 失败呈现为失败，
      // 而不是「提交成功所以算成功」。
      return { ok: error === undefined, committed, commitOid, pushed, error }
    }

    if (options.timeoutMs === undefined) return work()

    // 超时按失败处理，但底层 git 调用不会被取消（isomorphic-git 没有 abort），
    // 所以只保证本方法及时返回，不保证磁盘状态停在中途。
    return new Promise<CommitPushResult>(resolve => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        resolve({
          ok: false,
          committed: 0,
          pushed: false,
          error: `timed out after ${options.timeoutMs}ms`
        })
      }, options.timeoutMs)

      work()
        .then(result => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve(result)
        })
        .catch(err => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const message = err instanceof Error ? err.message : String(err)
          resolve({ ok: false, committed: 0, pushed: false, error: message.slice(0, 500) })
        })
    })
  }

  /**
   * 当前分支与最近提交（契约 §4.1，给状态展示用）。
   *
   * 分支尚未产生任何提交时 resolveRef 会失败；那就只回分支名。
   * repo 不存在或 HEAD 不可解都吞掉返回 {}——这是只读投影，不该因展示失败报错。
   */
  async getHead(repoId: string): Promise<{ branch?: string; commitOid?: string }> {
    const repo = this.repos.get(repoId)
    if (!repo) return {}

    let branch: string | undefined
    try {
      const current = await Git.currentBranch({ fs: fsSync, dir: repo.localPath })
      if (typeof current === 'string' && current.length > 0) branch = current
    } catch {}

    let commitOid: string | undefined
    try {
      commitOid = await Git.resolveRef({ fs: fsSync, dir: repo.localPath, ref: 'HEAD' })
    } catch {}

    return { branch, commitOid }
  }

  /**
   * 本地是否已经有 `repo.branch` 这个分支。
   *
   * 工作区刚 init、还没有任何提交时不存在分支，此时 push 只会得到一个
   * NotFoundError——那不是「远端不可达」，而是「没什么可推」，报成失败会误导。
   * 提交数为 0 但仍要 push（补推上次失败的分支）时会先用它挡一下。
   */
  private async hasLocalBranch(repo: RepoConfig): Promise<boolean> {
    try {
      await Git.resolveRef({ fs: fsSync, dir: repo.localPath, ref: repo.branch })
      return true
    } catch {
      return false
    }
  }

  async syncRepo(repoId: string, options: SyncOptions): Promise<SyncResult> {
    const repo = this.repos.get(repoId)
    if (!repo) {
      throw new Error(`Repo not found: ${repoId}`)
    }

    this.emit('sync-started', repoId, options.operation)

    try {
      let result: SyncResult

      switch (options.operation) {
        case 'fetch':
          result = await this.fetch(repo, options)
          break
        case 'pull':
          result = await this.pull(repo, options)
          break
        case 'push':
          result = await this.push(repo, options)
          break
        case 'status':
          result = await this.status(repo, options)
          break
        default:
          throw new Error(`Unknown operation: ${options.operation}`)
      }

      this.emit('sync-complete', result)
      return result
    } catch (error) {
      const err = error as Error
      const result: SyncResult = {
        success: false,
        operation: options.operation,
        repoId,
        error: err.message
      }
      this.emit('sync-failed', repoId, err, options.operation)
      return result
    }
  }

  private async fetch(repo: RepoConfig, options: SyncOptions): Promise<SyncResult> {
    const remote = options.remote || 'origin'

    this.emit('sync-progress', repo.repoId, { phase: 'fetching', loaded: 0, total: 100 })

    await Git.fetch({
      fs: fsSync,
      dir: repo.localPath,
      remote,
      ref: options.branch || repo.branch,
      http: this.getHttpClient(repo),
      onAuth: this.getAuthCallback(repo),
      // GitProgressEvent carries only phase/loaded/total.
      onProgress: (progress) => {
        this.emit('sync-progress', repo.repoId, {
          phase: 'fetching',
          loaded: progress.loaded || 0,
          total: progress.total || 100
        })
      }
    })

    this.emit('sync-progress', repo.repoId, { phase: 'fetching', loaded: 100, total: 100 })

    // Check for conflicts after fetch
    const statusResult = await this.status(repo, { operation: 'status' })
    if (statusResult.conflicts && statusResult.conflicts.length > 0) {
      this.emit('conflict-detected', repo.repoId, statusResult.conflicts)
    }

    return {
      success: true,
      operation: 'fetch',
      repoId: repo.repoId,
      output: 'Fetch completed'
    }
  }

  private async pull(repo: RepoConfig, options: SyncOptions): Promise<SyncResult> {
    await this.fetch(repo, options)

    this.emit('sync-progress', repo.repoId, { phase: 'merging', loaded: 0, total: 100 })

    // isomorphic-git's pull resolves void: a conflict surfaces as a rejection
    // or as conflicted entries in the working tree, so inspect the tree after.
    await Git.pull({
      fs: fsSync,
      dir: repo.localPath,
      remote: options.remote || 'origin',
      ref: options.branch || repo.branch,
      http: this.getHttpClient(repo),
      onAuth: this.getAuthCallback(repo),
      singleBranch: true
    })

    this.emit('sync-progress', repo.repoId, { phase: 'merging', loaded: 100, total: 100 })

    const statusResult = await this.status(repo, { operation: 'status' })
    if (statusResult.conflicts && statusResult.conflicts.length > 0) {
      this.emit('conflict-detected', repo.repoId, statusResult.conflicts)
      return {
        success: false,
        operation: 'pull',
        repoId: repo.repoId,
        error: 'Merge conflicts detected',
        conflicts: statusResult.conflicts
      }
    }

    return {
      success: true,
      operation: 'pull',
      repoId: repo.repoId,
      output: 'Pull completed',
      commitsAhead: statusResult.commitsAhead,
      commitsBehind: statusResult.commitsBehind
    }
  }

  private async push(repo: RepoConfig, options: SyncOptions): Promise<SyncResult> {
    this.emit('sync-progress', repo.repoId, { phase: 'pushing', loaded: 0, total: 100 })

    const pushResult = await Git.push({
      fs: fsSync,
      dir: repo.localPath,
      remote: options.remote || 'origin',
      ref: options.branch || repo.branch,
      http: this.getHttpClient(repo),
      onAuth: this.getAuthCallback(repo),
      force: options.force || false,
      onProgress: (progress) => {
        this.emit('sync-progress', repo.repoId, {
          phase: 'pushing',
          loaded: progress.loaded || 0,
          total: progress.total || 100
        })
      }
    })

    this.emit('sync-progress', repo.repoId, { phase: 'pushing', loaded: 100, total: 100 })

    // `error` is non-null only when a ref failed to update; `refs` carries the
    // per-ref outcome.
    if (pushResult.error !== null) {
      return {
        success: false,
        operation: 'push',
        repoId: repo.repoId,
        error: pushResult.error
      }
    }

    const refs = Object.keys(pushResult.refs ?? {})
    return {
      success: true,
      operation: 'push',
      repoId: repo.repoId,
      output: refs.length > 0 ? `Pushed: ${refs.join(', ')}` : 'Push completed'
    }
  }

  private async status(repo: RepoConfig, options: SyncOptions): Promise<SyncResult> {
    const statusMatrix = await Git.statusMatrix({
      fs: fsSync,
      dir: repo.localPath
    })

    const files: FileStatus[] = []
    const conflicts: string[] = []

    // StatusRow = [filepath, HeadStatus (0|1), WorkdirStatus (0|1|2), StageStatus (0|1|2|3)]
    for (const [filepath, head, workdir, stage] of statusMatrix) {
      const status = classifyStatus(head, workdir, stage)
      const staged = stage === 1 || stage === 2 || stage === 3

      if (status === 'conflicted') {
        conflicts.push(filepath)
      }

      files.push({ filepath, status, staged })
    }

    // Ahead/behind against the tracking ref. isomorphic-git has no porcelain
    // for this: walk both tips back to their merge base and count the hops.
    let commitsAhead = 0
    let commitsBehind = 0
    try {
      const branch = options.branch || repo.branch
      const localOid = await Git.resolveRef({ fs: fsSync, dir: repo.localPath, ref: branch })
      const remoteOid = await Git.resolveRef({
        fs: fsSync,
        dir: repo.localPath,
        ref: `refs/remotes/origin/${branch}`
      })
      if (localOid !== remoteOid) {
        const base = await Git.findMergeBase({
          fs: fsSync,
          dir: repo.localPath,
          oids: [localOid, remoteOid]
        })
        const baseOid = base[0]
        if (typeof baseOid === 'string') {
          commitsAhead = await this.countCommits(repo.localPath, localOid, baseOid)
          commitsBehind = await this.countCommits(repo.localPath, remoteOid, baseOid)
        }
      }
    } catch {}

    return {
      success: true,
      operation: 'status',
      repoId: repo.repoId,
      output: JSON.stringify(files),
      conflicts: conflicts.length > 0 ? conflicts : undefined,
      filesChanged: files.filter(f => f.status !== 'unmodified').length,
      commitsAhead,
      commitsBehind
    }
  }

  /** Count commits reachable from `from` but not from `stop`, first-parent walk. */
  private async countCommits(localPath: string, from: string, stop: string): Promise<number> {
    let count = 0
    let cursor: string | undefined = from
    while (cursor !== undefined && cursor !== stop) {
      count++
      if (count > 10000) break
      const commit = await Git.readCommit({ fs: fsSync, dir: localPath, oid: cursor })
      cursor = commit.commit.parent[0]
    }
    return count === 10000 ? 0 : count
  }

  private async configureAuth(localPath: string, auth: RepoConfig['auth']): Promise<void> {
    if (!auth) return

    if (auth.type === 'token' && auth.token) {
      // Per-repo credential helper; isomorphic-git reads it through `setConfig`.
      // The callback form keeps the token out of the object URL.
      await Git.setConfig({
        fs: fsSync,
        dir: localPath,
        path: 'credential.helper',
        value: `!f() { echo "username=${auth.username || 'oauth2'}"; echo "password=${auth.token}"; }; f`
      })
    } else if (auth.type === 'ssh' && auth.sshKeyPath) {
      // SSH auth would require additional setup
      // For now, we assume SSH agent is running
    }
  }

  private getAuthCallback(repo: RepoConfig): ((url: string) => Promise<{ username?: string; password?: string }>) | undefined {
    if (!repo.auth) return undefined

    if (repo.auth.type === 'token' && repo.auth.token) {
      return async () => ({
        username: repo.auth!.username || 'oauth2',
        password: repo.auth!.token
      })
    }

    return undefined
  }

  /** The node HTTP client `fetch`/`pull`/`push` require; absent = those calls reject. */
  private getHttpClient(_repo: RepoConfig) {
    return http
  }

  private startAutoSync(repoId: string): void {
    const repo = this.repos.get(repoId)
    if (!repo || !repo.autoSync) return

    const interval = setInterval(async () => {
      try {
        this.emit('auto-sync-triggered', repoId)
        await this.syncRepo(repoId, { operation: 'pull' })
      } catch (error) {
        this.ctx.logger.warn(`[cross-transfer] Auto-sync failed for ${repoId}:`, error)
      }
    }, repo.syncInterval)

    this.syncIntervals.set(repoId, interval)
  }

  private stopAutoSync(repoId: string): void {
    const interval = this.syncIntervals.get(repoId)
    if (interval) {
      clearInterval(interval)
      this.syncIntervals.delete(repoId)
    }
  }

  private generateRepoId(): string {
    return `repo_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }

  shutdown(): void {
    for (const [repoId] of this.syncIntervals) {
      this.stopAutoSync(repoId)
    }
    this.repos.clear()
    this.ctx.logger.info('[cross-transfer] Git sync service shut down')
  }
}