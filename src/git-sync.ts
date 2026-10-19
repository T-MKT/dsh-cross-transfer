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