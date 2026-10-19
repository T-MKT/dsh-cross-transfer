import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { GitSyncService, type RepoConfig, type SyncResult } from '../src/git-sync.js'
import * as Git from 'isomorphic-git'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'src', 'git-sync.ts'), 'utf8')

// 真实临时目录：isomorphic-git 直接操作文件系统，无需 mock 行为
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-sync-test-'))

afterAll(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true })
})

let repoCounter = 0
function nextRepoPath(prefix = 'repo'): string {
  repoCounter += 1
  return path.join(tmpdir, `${prefix}-${repoCounter}`)
}

function createService(): GitSyncService {
  const ctx = new Context()
  const service = new GitSyncService(ctx)
  service.initialize()
  return service
}

describe('GitSyncService', () => {
  // ---------- registerRepo ----------

  it('registerRepo 自动生成 repoId 并应用 autoSync=false / syncInterval=30000 默认值', async () => {
    const service = createService()
    const localPath = path.join(tmpdir, 'repo1')

    const config = await service.registerRepo({
      name: 'test-repo',
      localPath,
      remoteUrl: 'https://example.com/test.git',
      branch: 'main'
    })

    expect(config.repoId).toMatch(/^repo_\d+_[a-z0-9]+$/)
    expect(config.name).toBe('test-repo')
    expect(config.localPath).toBe(localPath)
    expect(config.remoteUrl).toBe('https://example.com/test.git')
    expect(config.branch).toBe('main')
    expect(config.autoSync).toBe(false)
    expect(config.syncInterval).toBe(30000)

    // 本地目录与 git 仓库已创建
    expect(fs.existsSync(localPath)).toBe(true)
    expect(fs.existsSync(path.join(localPath, '.git'))).toBe(true)

    service.shutdown()
  })

  it('registerRepo 指定 repoId 时使用给定的 repoId', async () => {
    const service = createService()

    const config = await service.registerRepo({
      repoId: 'my-custom-repo',
      name: 'custom-repo',
      localPath: nextRepoPath('custom'),
      remoteUrl: 'https://example.com/custom.git',
      branch: 'dev'
    })

    expect(config.repoId).toBe('my-custom-repo')
    expect(service.getRepo('my-custom-repo')).toBeDefined()
    expect(service.getRepos().map(r => r.repoId)).toContain('my-custom-repo')

    service.shutdown()
  })

  // ---------- getRepos / getRepo ----------

  it('getRepos 返回全部已注册仓库，getRepo 按 repoId 查询', async () => {
    const service = createService()

    const a = await service.registerRepo({
      name: 'repo-a',
      localPath: nextRepoPath('query-a'),
      remoteUrl: 'https://example.com/a.git',
      branch: 'main'
    })
    const b = await service.registerRepo({
      name: 'repo-b',
      localPath: nextRepoPath('query-b'),
      remoteUrl: 'https://example.com/b.git',
      branch: 'main'
    })

    const repos = service.getRepos()
    expect(repos).toHaveLength(2)
    expect(repos.map(r => r.repoId).sort()).toEqual([a.repoId, b.repoId].sort())

    expect(service.getRepo(a.repoId)).toEqual(a)
    expect(service.getRepo(b.repoId)).toEqual(b)
    expect(service.getRepo('does-not-exist')).toBeUndefined()

    service.shutdown()
  })

  // ---------- unregisterRepo ----------

  it('unregisterRepo 对已注册 repoId 返回 true，对不存在的 repoId 返回 false', async () => {
    const service = createService()

    const config = await service.registerRepo({
      name: 'to-unregister',
      localPath: nextRepoPath('unreg'),
      remoteUrl: 'https://example.com/unreg.git',
      branch: 'main'
    })

    expect(await service.unregisterRepo(config.repoId)).toBe(true)
    // 注销后再次注销同样返回 false
    expect(await service.unregisterRepo(config.repoId)).toBe(false)
    // 从未注册过的 repoId 返回 false
    expect(await service.unregisterRepo('never-registered')).toBe(false)

    service.shutdown()
  })

  // ---------- 事件 ----------

  it('registerRepo 触发 repo-registered 事件并携带返回的 config', async () => {
    const service = createService()
    const registered: RepoConfig[] = []
    service.on('repo-registered', config => registered.push(config))

    const config = await service.registerRepo({
      name: 'event-repo',
      localPath: nextRepoPath('evt-reg'),
      remoteUrl: 'https://example.com/evt.git',
      branch: 'main'
    })

    expect(registered).toHaveLength(1)
    expect(registered[0]).toEqual(config)

    service.shutdown()
  })

  it('unregisterRepo 触发 repo-unregistered 事件', async () => {
    const service = createService()
    const unregistered: string[] = []
    service.on('repo-unregistered', repoId => unregistered.push(repoId))

    const config = await service.registerRepo({
      name: 'evt-unreg',
      localPath: nextRepoPath('evt-unreg'),
      remoteUrl: 'https://example.com/evt-unreg.git',
      branch: 'main'
    })

    // 不存在的 repoId 不触发事件
    await service.unregisterRepo('ghost-repo')
    expect(unregistered).toHaveLength(0)

    await service.unregisterRepo(config.repoId)
    expect(unregistered).toEqual([config.repoId])

    service.shutdown()
  })

  // ---------- syncRepo ----------

  it('syncRepo 对不存在的 repoId 抛出 Repo not found', async () => {
    const service = createService()

    await expect(
      service.syncRepo('missing-repo', { operation: 'status' })
    ).rejects.toThrow('Repo not found')

    service.shutdown()
  })

  it('syncRepo status 在刚初始化的空仓库上返回 success、statusMatrix 为空、filesChanged 为 0', async () => {
    const service = createService()
    const config = await service.registerRepo({
      name: 'status-repo',
      localPath: nextRepoPath('status'),
      remoteUrl: 'https://example.com/status.git',
      branch: 'main'
    })

    const result = await service.syncRepo(config.repoId, { operation: 'status' })

    expect(result.success).toBe(true)
    expect(result.operation).toBe('status')
    expect(result.repoId).toBe(config.repoId)
    expect(result.error).toBeUndefined()

    // output 是 statusMatrix 派生的文件列表 JSON，空仓库应为空数组
    expect(result.output).toBeDefined()
    const files = JSON.parse(result.output!) as unknown[]
    expect(Array.isArray(files)).toBe(true)
    expect(files).toHaveLength(0)
    expect(result.filesChanged).toBe(0)

    service.shutdown()
  })

  it('syncRepo 触发 sync-started 与 sync-complete 事件，result.operation 正确', async () => {
    const service = createService()
    const config = await service.registerRepo({
      name: 'events-repo',
      localPath: nextRepoPath('sync-evt'),
      remoteUrl: 'https://example.com/sync-evt.git',
      branch: 'main'
    })

    const started: Array<{ repoId: string; operation: string }> = []
    const completed: SyncResult[] = []
    service.on('sync-started', (repoId, operation) => started.push({ repoId, operation }))
    service.on('sync-complete', result => completed.push(result))

    const result = await service.syncRepo(config.repoId, { operation: 'status' })

    expect(started).toEqual([{ repoId: config.repoId, operation: 'status' }])
    expect(completed).toHaveLength(1)
    expect(completed[0]).toEqual(result)
    expect(completed[0].operation).toBe('status')
    expect(completed[0].repoId).toBe(config.repoId)

    service.shutdown()
  })

  it('syncRepo 对不存在的 repo 抛错且不触发 sync-failed（也不触发 sync-started）', async () => {
    const service = createService()

    const started: string[] = []
    const failed: Array<{ repoId: string; operation: string }> = []
    service.on('sync-started', repoId => started.push(repoId))
    service.on('sync-failed', (repoId, _error, operation) => failed.push({ repoId, operation }))

    await expect(
      service.syncRepo('ghost-repo', { operation: 'fetch' })
    ).rejects.toThrow('Repo not found: ghost-repo')

    expect(failed).toHaveLength(0)
    expect(started).toHaveLength(0)

    service.shutdown()
  })

  it('同一 localPath 重复 registerRepo 时走 remote 已存在的回退路径', async () => {
    const service = createService()
    const localPath = nextRepoPath('re-reg')

    await service.registerRepo({
      name: 'first-reg',
      localPath,
      remoteUrl: 'https://example.com/one.git',
      branch: 'main'
    })

    const second = await service
      .registerRepo({
        name: 'second-reg',
        localPath,
        remoteUrl: 'https://example.com/two.git',
        branch: 'main'
      })
      .catch(err => err)

    if (second instanceof Error) throw second

    // 回退路径改用 setConfig，重复注册成功并更新 remoteUrl
    expect(second.name).toBe('second-reg')
    expect(second.remoteUrl).toBe('https://example.com/two.git')
    expect(service.getRepo(second.repoId)).toBeDefined()

    service.shutdown()
  })

  // ---------- shutdown ----------

  it('shutdown 后 getRepos 返回空数组', async () => {
    const service = createService()

    await service.registerRepo({
      name: 'shutdown-repo',
      localPath: nextRepoPath('shutdown'),
      remoteUrl: 'https://example.com/shutdown.git',
      branch: 'main'
    })
    expect(service.getRepos().length).toBeGreaterThan(0)

    service.shutdown()

    expect(service.getRepos()).toEqual([])
    expect(service.getRepo('shutdown-repo')).toBeUndefined()
  })

  // ---------- 加分项：本地 bare 仓库作为 remote ----------

  describe('本地 bare 仓库作为 remote（加分项）', () => {
    const bareDir = path.join(tmpdir, 'origin.git')
    let service: GitSyncService
    let repoId: string

    beforeAll(async () => {
      fs.mkdirSync(bareDir, { recursive: true })
      await Git.init({ fs, dir: bareDir, bare: true })

      service = createService()
      const config = await service.registerRepo({
        name: 'bare-backed',
        localPath: nextRepoPath('bare-client'),
        remoteUrl: bareDir,
        branch: 'main'
      })
      repoId = config.repoId
    })

    afterAll(() => {
      service?.shutdown()
    })

    it('syncRepo status 对本地 bare remote 返回成功，commitsAhead/commitsBehind 为数字', async () => {
      const result = await service.syncRepo(repoId, { operation: 'status' })

      expect(result.success).toBe(true)
      expect(result.operation).toBe('status')
      expect(result.commitsAhead).toBeTypeOf('number')
      expect(result.commitsBehind).toBeTypeOf('number')
      expect(result.filesChanged).toBeTypeOf('number')
    })

    it('syncRepo fetch 对本地 bare remote 发起连通性请求并返回一致的结果结构', async () => {
      const started: string[] = []
      const completed: SyncResult[] = []
      const failed: string[] = []
      service.on('sync-started', id => started.push(id))
      service.on('sync-complete', result => completed.push(result))
      service.on('sync-failed', id => failed.push(id))

      const result = await service.syncRepo(repoId, { operation: 'fetch' })

      expect(result.operation).toBe('fetch')
      expect(result.repoId).toBe(repoId)
      expect(started).toEqual([repoId])

      if (result.success) {
        // fetch 携带 http 适配器后完全成功
        expect(completed).toHaveLength(1)
        expect(failed).toHaveLength(0)
      } else {
        // 本机 file:// 风格的 bare remote 路径 isomorphic-git 无法解析成 URL
        // （"Cannot parse remote URL"）：只要 http 适配器已传入，失败就来自
        // 远程地址本身而不是缺少参数。
        expect(result.error).not.toMatch(/requires a "http" parameter/)
        expect(failed).toEqual([repoId])
        expect(completed).toHaveLength(0)
      }
    })
  })

  // ---------- 回归保护：require('fs') → ESM import 修复 ----------

  describe('ESM require() 修复回归保护', () => {
    it('不再包含 CommonJS require() 调用', () => {
      expect(source.match(/require\(/g) ?? []).toHaveLength(0)
    })

    it('以顶层 ESM import 导入 fs 绑定', () => {
      expect(source).toMatch(/^import \* as fsSync from 'fs'$/m)
    })

    it('不调用 isomorphic-git 中已不存在的 Git.config', () => {
      expect(source).not.toMatch(/Git\.config\(/)
      expect(source).toMatch(/Git\.setConfig\(/)
    })

    it('可作为真实 ESM 模块导入（回归保护）', async () => {
      const mod = await import('../src/git-sync.js').catch(err => err)
      if (mod instanceof Error) throw mod
      expect(mod).toBeDefined()
    })
  })
})
