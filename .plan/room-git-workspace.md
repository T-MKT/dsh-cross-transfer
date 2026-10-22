# 房间 Git 工作区同步：冻结设计（v1）

> 状态：**契约已冻结**。实现期间不得更改本文件定义的导出形状、消息类型、路由与错误码；
> 需要变更时必须先停下来报告，而不是自行改契约。
> 调研基线：2026-10-21，dsh `0.2.1-rc.2`，仓库 `48dea6f`，343 个测试全绿。

## 1 需求

1. 房主建房时可以设置一个 Git 仓库（远端、分支、凭据、是否自动推送）。
2. 房间成员各自为本房间选择一个**宿主本机的工作区目录**。
3. dsh 里的 AI 在该工作区改完文件（一个回合结束）后，插件**默认**把这些改动提交并推送到房间设置的仓库。
4. 手动"立即同步"始终可用；失败必须可见（状态里带错误），不能静默。

## 2 已核实的环境事实（不要重复调研）

- 宿主半是 cordis 模块插件；服务名：`webServer`、`rooms`(RoomService)、`chat`、`gitSync`(GitSyncService)、`wss`；房主判定 `RoomService.isOwner(roomId, realDeviceId)`。
- 宿主（dsh 0.2.1-rc.2）提供（**以 `ctx.get(name)` 可选读取，缺失必须优雅降级**）：
  - `ctx.get('workspaceChanges')` → `{ summary(sessionId, seq): WorkspaceChangesSummary | undefined }`，
    `WorkspaceChangesSummary = { turn, cwd, files: { path, display, added, deleted, binary?, oversized? }[], total, added, deleted }`。
    AI 回合结束时，dsh-workspace-changes 会向会话日志 append `'workspace/changes'` 事件。
  - `ctx.sessions.list()` → `Session[]`，`session.header.cwd` 是会话创建目录（可选）。
  - `ctx.workspaceRegistry.list?` 不可靠：只用于候选目录，取不到就返回空数组。
- cordis 的 `ctx.get(name, strict?)` 可用且不需要 inject；`ctx.on(name, listener)` 返回退订函数。
- `isomorphic-git@1.43.1`：**不能**推送到本地目录或 `file://`（"unrecognized transport protocol"），
  只支持 http(s)（`isomorphic-git/http/node`）。SSH 未实现。因此远端只接受 `http://` / `https://`。
- 测试脚本路径（Windows，`node` 直接跑，禁止 `npm`/`npx`）：
  - typecheck：`node node_modules/typescript/bin/tsc --noEmit`
  - 测试：`node node_modules/vitest/vitest.mjs --run`
  - 构建：`node node_modules/tsdown/dist/run.js` 然后 `node scripts/wrap-client.mjs`

## 3 数据形状（冻结）

新增 `src/room-workspace.ts`：

```ts
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
```

`RoomInfo` 增加一个字段：`repoConfigured: boolean`（公开投影里只暴露布尔值，绝不暴露 URL）。

## 4 服务端

### 4.1 `GitSyncService` 扩展（`src/git-sync.ts`，新增公开方法，不改旧行为）

```ts
export interface EnsureRepoInput {
  repoId: string
  name: string
  localPath: string
  remoteUrl: string
  branch: string
  auth?: RoomRepoAuthInput   // 或复用 RepoConfig['auth']
}

export interface CommitPushResult {
  ok: boolean
  committed: number          // 本次提交的文件数
  commitOid?: string
  pushed: boolean
  error?: string
}

/** 目录必须已存在且是目录（不 mkdir）；不是 git 仓库则 init；设置 origin；不写 credential.helper。 */
ensureRepo(input: EnsureRepoInput): Promise<RepoConfig>

/** 暂存全部改动（新增/修改/删除）→ 有变化才 commit → 按需 push。push 失败不抛，返回 ok=false。 */
commitAndPush(repoId: string, options: { message: string; authorName: string; authorEmail: string; push: boolean; timeoutMs?: number }): Promise<CommitPushResult>

/** 当前分支与最近提交（给状态展示）。 */
getHead(repoId: string): Promise<{ branch?: string; commitOid?: string }>
```

实现要点：
- 用 `Git.statusMatrix` 判定；`workdir === 2` → `Git.add`，`head === 1 && workdir === 0` → `Git.remove`；
  `head === 1 && workdir === 1` 视为未变化。
- `Git.commit` 的 author/committer 都用传入值；无变化时 `committed = 0` 且不提交。
- push 用现有 `getHttpClient` + `getAuthCallback`；`push` 失败只记录 `error`（截断到 500 字符）。
- `ensureRepo` 的 auth 只走回调，**不写** `credential.helper`（旧 `configureAuth` 会把明文 token 写进 git config，新路径不得复用）。

### 4.2 新服务 `RoomWorkspaceService`（`src/room-workspace.ts`）

```ts
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

export class RoomWorkspaceService extends Service {
  constructor(ctx: Context, rooms: RoomService, gitSync: GitSyncService)
  initialize(config?: Partial<RoomGitConfig>): void

  // 房主
  configureRepo(roomId: string, actorDeviceId: string, input: RoomRepoConfigInput): Promise<RoomRepoStatus>
  clearRepo(roomId: string, actorDeviceId: string): Promise<RoomRepoStatus>
  /** 纯校验（不落盘、不联网）：建房前先挡一次，避免建出半配置房间。 */
  validateRepoConfig(input: RoomRepoConfigInput): void

  // 成员
  bindWorkspace(roomId: string, deviceId: string, workspacePath: string): Promise<RoomRepoStatus>
  unbindWorkspace(roomId: string, deviceId: string): Promise<RoomRepoStatus>
  sync(roomId: string, deviceId: string, trigger?: 'auto' | 'manual'): Promise<SyncSummary>

  // 读
  status(roomId: string, viewerDeviceId: string): RoomRepoStatus
  candidates(): Promise<string[]>

  // 宿主钩子
  /** cwd 命中绑定 → 去抖后提交+推送；返回本次触发的同步结果（可能为空）。 */
  handleWorkspaceChanges(cwd: string, summary: { files: { path: string }[]; total: number }): Promise<SyncSummary[]>
  /** 订阅 dsh 的 'session/event'，读 workspaceChanges.summary；依赖缺失时只记录一条 info 日志并退化。
   *  事件形状：{ type: 'workspace/changes', seq, data: { turn } }；session.id 是 SessionId（字符串）。
   *  读 summary 用 ctx.get('workspaceChanges')?.summary(session.id, event.seq)，不存在则忽略。 */
  attachHost(): () => void

  onRoomClosed(roomId: string): void
  shutdown(): void
}
```

服务名：`super(ctx, 'roomWorkspace')`。事件（自建 typed emitter，不覆盖 Service 的 on/emit）：
`'status-changed': [roomId, RoomRepoStatus]`、`'sync-finished': [roomId, deviceId, SyncSummary]`。

行为规则（实现必须逐条满足，测试逐条覆盖）：
1. **权限**：`configureRepo`/`clearRepo` 只允许 `rooms.isOwner`；其余操作要求 `rooms.isMember`；
   非成员 → `RoomError('not-a-member')`，成员非房主调房主操作 → `RoomError('forbidden')`。
2. **配置校验**（纯内存、无网络、无磁盘）：
   - `remoteUrl` 只接受 `http:`/`https:`，否则 `RoomError('invalid-repo')`；
   - URL 内嵌 userinfo（`https://u:p@host/...`）时抽出 `username`/`password` 作为 auth，存储值必须剥离；
   - 若同时给了 `auth` 与内嵌 userinfo → `invalid-repo`；
   - `branch` 默认 `main`，必须匹配 `^[A-Za-z0-9._/-]{1,128}$` 且不含 `..`、不以 `-` 开头；
   - `roomGit.enabled === false` 时所有写操作 → `RoomError('forbidden')`。
3. **绑定**（`bindWorkspace`）：
   - 路径必须绝对、存在、是目录（`fs.stat`），否则 `RoomError('invalid-workspace')`；
   - 规范化：`fs.realpathSync.native`（失败回退 `path.resolve`）；Windows 比较大小写不敏感（统一 `toLowerCase()` 作键）；
   - 房间仓库未配置 → `RoomError('invalid-repo')`（先让房主设置仓库）；
   - 绑定时同步执行 `gitSync.ensureRepo({ repoId: 'room:' + roomId, localPath, remoteUrl, branch, auth })`；
     失败 → `RoomError('invalid-workspace', '工作区无法初始化为 Git 仓库: …')`；
   - 同设备重复绑定 = 更新；绑定数超上限 → `RoomError('too-many-rooms')`？**不新增码**，用 `RoomError('invalid-argument', 'too many bindings')`。
4. **同步**：按 `roomId + deviceId` 串行（promise 链）+ 去抖；同一绑定正在同步时新触发只置脏标记，结束后补跑一次。
   - 提交信息：`chore(cross-transfer): <房间名或 roomId> 自动同步 <N> 个文件`，N 超过 20 时附 `…(+K)`；
   - `autoCommit === false` 时手动同步仍执行提交（手动 = 用户明确要求），自动触发直接跳过；
   - `autoPush === false` 时只提交不推送，`pushed=false`；
   - 结果写入 binding.lastSync 并 emit `sync-finished`；失败也要 emit（`ok=false`，带 error）。
5. **自动触发**：`handleWorkspaceChanges(cwd, summary)` 找出规范化路径等于 `cwd` 的所有绑定（可能跨房间），
   每个绑定按 `debounceMs` 合并后触发 `sync(roomId, deviceId, 'auto')`；`summary.total === 0` 时跳过。
6. **房间关闭/成员踢出**：`onRoomClosed(roomId)` 清掉该房配置与绑定并清定时器；成员被踢时由 gateway 调
   `unbindWorkspace`（kick 后调用一次，失败忽略）。退房同理。
7. **候选目录**：`candidates()` 依次尝试 `ctx.get('sessions')?.list()` 的 `header.cwd`、
   `ctx.get('workspaceRegistry')?.list?.()` 的 `path`（形状不确定，逐项 try/catch），去重、只保留存在的目录，
   截断到 `maxCandidates`；任何依赖缺失返回 `[]`（绝不抛）。

### 4.3 错误码（`src/rooms.ts` 的 `RoomErrorCode` 增加三项）

| code | HTTP |
|---|---|
| `invalid-repo` | 400 |
| `invalid-workspace` | 400 |
| `sync-failed` | 502 |

同步失败在服务层**不抛** `sync-failed`（结果对象里带 `ok=false`）；该码保留给 REST/WS 层在
`sync()` 自身抛异常（例如绑定已不存在）时使用。`index.ts` 的 `ROOM_ERROR_STATUS` 同步补齐。

### 4.4 REST（挂在既有 prefix handler 内，位于房间路由段之后、404 之前）

鉴权统一走 `rooms.authenticateBearer(req.headers.authorization, roomId)`；票据必须属于该房
（`authenticate` 已校验），房主操作用 `requireOwnerTicket`。

| 方法 | 路径 | 鉴权 | 请求体 | 成功响应 |
|---|---|---|---|---|
| GET | `/rooms/:roomId/git` | 该房票据 | — | `200 RoomRepoStatus` |
| PUT | `/rooms/:roomId/git` | 房主票据 | `RoomRepoConfigInput` | `200 RoomRepoStatus` |
| DELETE | `/rooms/:roomId/git` | 房主票据 | — | `200 RoomRepoStatus` |
| PUT | `/rooms/:roomId/workspace` | 该房票据 | `{ path: string }` | `200 RoomRepoStatus` |
| DELETE | `/rooms/:roomId/workspace` | 该房票据 | — | `200 RoomRepoStatus` |
| POST | `/rooms/:roomId/git/sync` | 该房票据 | — | `200 { roomId, result: SyncSummary }` |
| GET | `/rooms/:roomId/workspaces` | 该房票据 | — | `200 { roomId, paths: string[] }` |

- 路由正则扩两族：`^\/rooms\/([0-9]{4,12})\/(members|close|password|lock|git|workspace|workspaces)$`、
  `^\/rooms\/([0-9]{4,12})\/git\/sync$`；方法不匹配仍走 405 `METHOD_NOT_ALLOWED`。
- `:roomId` 形状不合法时，新路由同样落 404（与现状一致），不额外抛错。
- 错误体沿用 `respondRoomError`。

### 4.5 WS 消息（`RoomGateway.handle` 增加 case；全部以 `room-` 开头，自动被门禁接管）

| type | 鉴权 | payload | 应答 type | 应答 payload |
|---|---|---|---|---|
| `room-git-config` | 房主（服务层再校验） | `{ roomId, repo: RoomRepoConfigInput }` | `room-git-status` | `RoomRepoStatus` |
| `room-git-clear` | 房主 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-git-status` | 成员 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-bind` | 成员 | `{ roomId, path }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-unbind` | 成员 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-candidates` | 成员 | `{ roomId }` | `room-workspace-candidates` | `{ roomId, paths }` |
| `room-git-sync` | 成员 | `{ roomId }` | `room-git-sync-result` | `{ roomId, result }` |

- `room-create` payload 增加可选 `repo?: RoomRepoConfigInput`：建房成功后立即 `configureRepo`
  （建房前先调 `validateRepoConfig`，纯校验失败直接回错误，不建房）；REST `/rooms/create` 同理。
- 广播（由 `status-changed` / `sync-finished` 驱动，发给成员会话，`deviceId: 'server'`）：
  - `room-git-status` payload `RoomRepoStatus`（接收者视角投影：路径只对本人与房主可见——
    广播时按会话 deviceId 逐个投影，用 `server.sendToSession` 而不是 `broadcastToSessions` 同一份 payload）；
  - `room-git-sync-result` payload `{ roomId, deviceId, result }`。
- 房间内被踢/退房时，gateway 调 `roomWorkspace.unbindWorkspace(roomId, deviceId)`，异常吞掉。

### 4.6 `src/index.ts` 接线

- 构造：`const roomWorkspace = new RoomWorkspaceService(ctx, rooms, gitSync)`；`initialize(config.roomGit)`；
  **构造在 RoomGateway 之前或之后均可，但必须在其 `subscribe()` 之前把事件桥接好**——由 RoomGateway 构造参数传入。
- `CrossTransferConfig` 增加 `roomGit` 块（schemastery，全部有默认值，整块 `.default({})`）：

```ts
roomGit: z.object({
  enabled: z.boolean().default(true),
  debounceMs: z.natural().default(1500),
  pushTimeoutMs: z.natural().default(60000),
  maxBindingsPerRoom: z.natural().default(16),
  maxCandidates: z.natural().default(50)
}).default({})
```

- `apply()` 末尾：`const detachHost = roomWorkspace.attachHost()`；teardown 里先 `detachHost()` 再 `shutdown()`。
- `RoomGateway` 构造签名增加 `roomWorkspace`；`subscribe()` 里桥接两个事件到广播。
- `RoomGateway.handle` 增加 7 个 case，模式与现有 handler 一致（`assertRoomId` + `requireSessionMember` +
  透传给服务层做权限判定）。

## 5 客户端（`src/client/`）

### 5.1 `CrossTransferClient.tsx`

```ts
setRoomGit(roomId: string, repo: RoomRepoConfigInput): Promise<RoomRepoStatus>
clearRoomGit(roomId: string): Promise<RoomRepoStatus>
getRoomGitStatus(roomId: string): Promise<RoomRepoStatus>
bindRoomWorkspace(roomId: string, path: string): Promise<RoomRepoStatus>
unbindRoomWorkspace(roomId: string): Promise<RoomRepoStatus>
listWorkspaceCandidates(roomId: string): Promise<string[]>
syncRoomGit(roomId: string): Promise<SyncSummary>
```

- 全部走 `roomRequest`（自动处理 `invalid-ticket` 重进房）。
- `CreateRoomOptions` 增加 `repo?: RoomRepoConfigInput`，透传到 `room-create` payload。
- 事件：`roomGitStatus: [status]`、`roomGitSync: [roomId, deviceId, result]`。
- `handleMessage`：`room-git-status` / `room-workspace-candidates` / `room-git-sync-result` 加入
  `ROOM_REPLY_TYPES` 与 `replyPayloadFor`；同时把推送形态（无 messageId）分派成上述事件。

### 5.2 `RoomPanel.tsx`

- 建房表单末尾加折叠区「Git 仓库（可选）」：远端 URL、分支（默认 main）、访问令牌（password 输入）、
  自动推送复选框。提交时组装 `repo`（remoteUrl 为空则不传）。
- 已进入房间区域后新增「仓库与工作区」区块（`sectionStyle`）：
  - 未配置：提示「房主尚未设置仓库」；房主可见配置表单。
  - 已配置：显示脱敏远端、分支、自动推送开关；成员可见「工作区路径」输入框 + `datalist` 候选
    （来自 `listWorkspaceCandidates`）+「绑定」/「解绑」/「立即同步」按钮。
  - 状态列表：每个成员一行（名字、已绑定/未绑定、上次同步时间与结果、错误文本）。
  - 房主额外可见「修改仓库」「清除仓库」。
  - 订阅 `roomGitStatus` / `roomGitSync` 刷新本地状态（按 roomId 存 `Record<roomId, RoomRepoStatus>`）。
- 所有文案中文，颜色只用 `var(--dsw-*)` token；新增错误码文案补进 `ERROR_TEXT`。

## 6 测试要求（每一条都是验收项）

1. `test/room-workspace.test.ts`（新）：
   - 配置校验：非 http(s) URL、带 userinfo、非法分支 → `invalid-repo`；userinfo 被剥离且转成 auth；
     投影里绝不出现 token。
   - 权限：非房主配置 → `forbidden`；非成员 → `not-a-member`。
   - 绑定：相对路径/不存在/不是目录 → `invalid-workspace`；未配置仓库 → `invalid-repo`；
     绑定后目录被 `git init`，状态带 `repoReady`。
   - 提交：新增/修改/删除文件后同步，commit 数量与 oid 正确；无变化时 `committed=0`、不产生新 commit。
   - 推送：用测试内嵌的最小 smart-HTTP 服务器（advertise `report-status`，回 `unpack ok` + `ok <ref>`）
     验证 push 成功路径；再验证远端不可达时 `ok=false`、`error` 非空、commit 仍然落盘。
     若该服务器实现不可行，退化为：commit 成功 + push 失败被记录，并在结论文档里明说未覆盖真实 push。
   - 自动钩子：`handleWorkspaceChanges(cwd, {files,…})` 命中绑定 → 触发一次同步；
     `debounceMs` 内多次触发合并为一次；`total=0` 不触发；cwd 不匹配不触发。
   - 并发：同一绑定同时两次 `sync()` 串行执行，第二次不产生重复 commit。
   - 房间关闭清理定时器与状态。
2. `test/ws-server.test.ts` 或新建 `test/room-workspace.e2e.test.ts`：
   - WS：房主 `room-git-config` 成功；成员调配置 → `forbidden`；成员绑定 → `room-git-status` 广播到同房其它成员；
     成员 `room-git-sync` 返回 `room-git-sync-result`；不同房间互不可见。
   - REST：7 条新路由的成功路径 + 401/403/405。
3. `test/client.test.ts` 扩展：新方法的 payload 形状、应答配对、事件派发、`repo` 透传到 `room-create`。
4. 回归：`node node_modules/typescript/bin/tsc --noEmit` 0 error；
   `node node_modules/vitest/vitest.mjs --run` 全绿（现有 343 个用例一个不能坏）。

## 7 文档

- `README.md`：功能列表加一条；新增「房间 Git 工作区同步」章节（配置、流程、REST、WS、数据形状、
  安全边界：token 只在内存、URL 脱敏、路径只对本人与房主可见、仅 http(s)、非快进 push 会失败需手动 pull）；
  配置参考表加 `roomGit` 五项。
- `cordis.patch.yml`：补 `roomGit` 默认值注释块。
- `COMPATIBLE_VERSION` 不动。

## 8 明确不做（v1 范围外）

- SSH 远端、本地裸仓库远端（isomorphic-git 不支持）。
- 自动 pull / 自动解决冲突 / 非快进合并（失败可见，交给用户手动 pull）。
- 文件级实时（每次 write）同步：只在 AI 回合结束时按 `workspace/changes` 触发。
- 浏览器选择宿主目录的原生文件对话框（浏览器拿不到宿主路径，用候选列表 + 文本输入）。
- 变更历史/回滚 UI。
