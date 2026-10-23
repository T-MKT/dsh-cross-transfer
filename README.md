# dsh-cross-transfer

DSH (DeepSeek Helper) 宿主插件：跨设备文件传输、房间化聊天与 Git 同步。宿主半（cordis 插件）挂载 WebSocket 信令与 REST 面；浏览器半（`dsh-cross-transfer/client`）提供客户端服务与 React 面板。所有房间语义的消息都经过房间门禁（room gate）裁决，默认拒绝（fail-closed）。

## 功能特性

- **房间机制**：房号 + 密码门禁、服务端票据鉴权、房主/成员角色、踢人 / 锁房 / 改密、空闲回收
- **房间内聊天**：消息按房号落内存历史（每房上限 1000 条），支持 typing 状态与历史拉取
- **WebSocket 信令**：WebRTC offer/answer/candidate、文件分片（file-offer/answer/chunk/complete）按 `targetDeviceId` 定向转发
- **设备身份**：服务端铸发 `deviceSecret`，`deviceId` 由它派生，客户端不自报身份
- **设备发现**：`GET /devices`、`GET /sessions` 查询在线设备与会话
- **文件传输**：REST 发起 + WS 分片转发，大小/分片可配
- **Git 同步**：仓库注册与 isomorphic-git 同步
- **房间 Git 工作区同步**：房主为房间设置 http(s) 仓库，成员各自绑定宿主本机工作区目录，AI 回合结束后默认提交并推送到该仓库
- **自动重连**：客户端断线 3s 退避重连，重连后凭内存密码自动重进房间

## 架构

```
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Device A       │◄──────────────────►│  DSH Host       │
│  (Browser)      │   /api/cross-      │  (cross-transfer)│
│                 │   transfer         │                  │
└─────────────────┘                    └────────┬────────┘
                                                │ WebSocket
                                                ▼
┌─────────────────┐     WebSocket      ┌─────────────────┐
│  Device B       │◄──────────────────►│                  │
│  (Browser)      │                    │                  │
└─────────────────┘                    └──────────────────┘
```

## 安装

```bash
pnpm add dsh-cross-transfer
```

## 宿主接入

在 DSH 宿主组合配置（cordis.patch.yml）中插入插件：

```yaml
- insert:
    - id: cross-transfer
      name: 'dsh-cross-transfer'
      config:
        path: '/api/cross-transfer'
        # tokenSecret: 'your-secret-key'  # 可省略；省略时每次启动随机生成
        maxFileSize: 1073741824  # 1GB
        chunkSize: 1048576       # 1MB
        rooms:                   # 整块可省略，缺省取下列默认值
          maxRooms: 100
          maxRoomsPerDevice: 5
          maxMembersPerRoom: 16
          roomCodeLength: 6
          minPasswordLength: 6
          maxJoinAttempts: 8
          joinAttemptWindowMs: 60000
          joinLockoutMs: 120000
          ticketTtlMs: 86400000
          idleTtlMs: 1800000
          closeWhenOwnerLeaves: true
          discoverableByDefault: true
          allowRoomList: true
        roomGit:                 # 整块可省略，缺省取下列默认值
          enabled: true
          debounceMs: 1500
          pushTimeoutMs: 60000
          maxBindingsPerRoom: 16
          maxCandidates: 50
```

宿主插件会：

- 在 `config.path` 挂载一个 WebSocket upgrade 路由与一个 REST 前缀路由
- 安装房间门禁：所有 `room-*` 与房间语义消息由 `RoomGateway` 裁决，未安装门禁时一律拒绝（`room-gate-unavailable`），没有「未配置即放行」的后门

完整配置说明见[配置参考](#配置参考)。仓库根目录的 `cordis.patch.yml` 是带注释的可直接粘贴示例。

---

## 房间机制

### 门禁模型（fail-closed）

带房间语义的 WS 消息——所有 `room-*` 类型、`chat-message` / `chat-history-request` / `typing`、以及 **payload 里带字符串 `roomId` 的任意自定义类型**——都不会走通用转发，全部交给房间门禁裁决：

- 门禁未安装：回 `error{ code: 'room-gate-unavailable' }`，零投递、零状态变更
- 门禁已安装但校验失败：回 `error{ code, message, retryAfterMs? }`，同样零投递
- 未列出的 `room-*` 类型或带 `roomId` 的自定义类型：`invalid-argument`，绝不放行也绝不转发给其它会话

### 设备身份（deviceSecret）

`deviceId` 不由客户端自报，而是由服务端铸发的凭据派生：

- `deviceId = sha256('xfer-device:' + deviceSecret)` 的前 16 个 hex 字符；`deviceSecret` 是 32 字节 hex（256-bit）
- `POST /devices/register` 登记：首次不带 `deviceSecret`，服务端铸发并返回 `{ deviceId, deviceSecret, deviceName, token }`；之后凭已有 secret 取回同一身份（secret 未登记 → `401 invalid-device`）
- 返回里的 `token` 就是 WS 连接参数（见下），不必再调一次 `/token`
- 凭据表在宿主进程内存中（上限 10000，LRU + 7 天未用淘汰）：**宿主重启即失效**，客户端检测到 `invalid-device` 后自动重新登记
- 旧版 `POST /token`（自报 `deviceId`）保留用于向后兼容：这种连接能做信令/文件转发，但**不能建房、不能进房**——建房/进房要求设备已通过 `/devices/register`（或 `/devices/token` 带 Bearer secret）证明身份

### 房号（RoomId）

- 格式：**4~12 位纯数字字符串**
- 建房时可自定义 `roomId`（同形状校验；已被占用 → `409 room-exists`），或留空由服务端生成
- 随机房号用 `crypto.randomInt` 在 `roomCodeLength` 位（默认 6，可配 4~12）的十进制区间内取值，碰撞重摇，最多 20 次仍碰撞 → `503 room-code-exhausted`
- 房号占用判定包含「建房占位」：并发用同一房号建房只有一个成功
- 房间关闭后留下墓碑：进已关闭的房号 → `410 room-closed`；墓碑不占用房号池，随机生成可复用旧房号

### 密码

- 长度 `minPasswordLength`（默认 6）~ 128 字符；进房/建房/改密都必须携带符合长度规则的 `password` 字符串字段
- 服务端**只存 scrypt 加盐哈希**，格式 `scrypt$N$r$p$saltHex$hashHex`：N=16384、r=8、p=1、keylen=64、16 字节随机盐；验证用 `timingSafeEqual`。参数随哈希一起存，便于将来升级
- 明文密码只在建房/进房/改密的请求参数里短暂存在：不落盘、不进日志、不出现在任何响应或推送里

### 进房判定顺序

`room-join` / `POST /rooms/join` 按以下顺序判定，命中即停：

1. 房号形状 → `400 invalid-room-id`；密码形状/长度 → `400 invalid-password`
2. **成员快速通道**：该设备已是本房成员（且身份已凭据证明）→ 直接挂上会话、置在线、重签票据并返回。**不校验锁、容量与密码正确性**（密码字段本身仍须合法）
3. 限流锁定 → `429 too-many-attempts`（带 `retryAfterMs`）
4. 房间不存在（或还在建房占位）→ 命中墓碑 `410 room-closed`，否则 `404 room-not-found`；**计入失败次数**
5. 已锁 → `423 room-locked`；计入失败
6. 容量满（含正在校验密码的预留）→ `409 room-full`；计入失败
7. 密码比对失败 → `401 wrong-password`；计入失败
8. 提交：写入成员行、签发票据、向房内广播 `user-joined`

### 试错限流与锁定

- 两个计数维度并行：`device:<deviceId>` 与 `ip:<roomId>:<remoteAddress>`（拿不到远端地址时只用前者）
- 窗口 `joinAttemptWindowMs`（默认 60s）内失败满 `maxJoinAttempts`（默认 8）次 → 锁定 `joinLockoutMs`（默认 120s）
- 锁定期间的进房尝试回 `too-many-attempts`，REST 同时带 `Retry-After: <秒>` 响应头
- 限流检查**先于存在性检查**：打错房号与打错密码同样消耗尝试次数，错误码差异不能被用来枚举房号
- 不做全房锁：一个房号被刷不会把整个房间锁死
- 成功建房/进房会清零该设备的失败计数

### 票据与鉴权

- 建房/进房成功返回票据 `RoomTicket { ticket, roomId, deviceId, role, issuedAt, expiresAt }`：`ticket` 是 64 位 hex（32 字节随机数），有效期 `ticketTtlMs`（默认 24h）
- 票据绑定 `(roomId, deviceId, role)`，服务端持有票据表、支持即时吊销：退房、被踢、关房、改密（房主本人票据除外）、空闲回收时全部吊销；重签时自动吊销同设备旧票
- REST 面鉴权：`Authorization: Bearer <房间票据 或 deviceSecret>`。房间操作优先按票据解析；拿本房票据访问别的房 → `401 invalid-ticket`
- WS 面不传票据：成员资格绑定在连接上（连接已通过 token 校验 + 设备已登记），服务端按「会话是否挂在成员行上」判定

### 房主权限

- 房主 = 建房时那条凭据派生的 deviceId，是房间属性，与在线状态无关
- 房主可以：关房、踢人、改密、锁房/解锁、以房主视角读成员列表（含**未脱敏**的真实 deviceId，供踢人使用）
- 房主不可以：踢自己（请用退房）、改房号、改 `maxMembers`（建房时定死）、主动转让房主（仅 `closeWhenOwnerLeaves: false` 时退房会自动移交给最早加入的在线成员）
- **踢人是彻底移除**：删成员行 + 摘掉被踢设备全部会话 + 吊销其全部票据——被踢者无法凭残留会话或成员快速通道免密回归，只能重新用密码进房
- **改密只挡住未来的新加入者**：已在房内的成员走快速通道，不受新密码影响；要清人请用踢人。改密时除房主本人外全部旧票据立即吊销

### 生命周期

- **断线**：只摘会话、席位保留（成员行还在，`online=false`）、该设备在这些房间的票据吊销；广播 `user-left`（`reason: 'disconnected'`）。房主最后一个会话断开时开始计时
- **房主显式退房**：`closeWhenOwnerLeaves: true`（默认）→ 关房（`reason: 'owner-left'`）；`false` → 房主移交给最早加入的在线成员（广播 `owner-changed`，全员重签票据），无在线成员则保留原房主身份
- **空闲回收**：后台清扫（周期 `max(1s, min(60s, idleTtlMs/4))`）在满足任一条件时关房（`reason: 'idle-timeout'`）：① 全员离线且最后活动超 `idleTtlMs`；② 房主离线超 `idleTtlMs`
- 最后活动时间（`lastActivityAt`）刷新点：建房、进房、退房、改密、锁房、房间内聊天消息与 typing
- 关房后：成员会话收到 `room-closed` 推送；该房号留下墓碑（上限 `maxRooms` 条）

### 容量与上限

| 上限 | 默认 | 说明 |
|---|---|---|
| `maxRooms` | 100 | 全局房间总数（含建房占位） |
| `maxRoomsPerDevice` | 5 | 每台设备可拥有的房间数 |
| `maxMembersPerRoom` | 16 | 单房间成员数（按设备去重、含房主、离线保留席位）；建房传入的 `maxMembers` 被夹到 `[1, maxMembersPerRoom]` |

### 安全边界与已知取舍

- **房号本身可被枚举，真正的门是密码**。房间列表（`GET /rooms`、WS `room-list`）只返回公开投影字段（无凭据、无 sessionId、房主与成员 deviceId 均脱敏为前 4 + '…' + 后 4），且只含 `discoverable` 的房间；`allowRoomList: false` 时两个面一律 `403 forbidden`。试错限流（8 次/60s，按设备与 IP+房号双维度，锁定 120s）抬高在线爆破成本
- **`deviceSecret` 是 bearer 凭据**：客户端明文存于 localStorage，XSS 或同机攻击可以窃取；泄露等同账号密码泄露（攻击者能以该身份进它所在的任何房间）。反过来，**只知道别人的 deviceId 没有用**：快速通道要求服务端登记过的凭据证明身份，自报 id 拿不到任何成员资格
- **密码在客户端以内存态保存**：为了断线/重连后自动重进房，浏览器客户端把密码放在内存 Map 里（不落 localStorage）。页面刷新即丢失、需要重新输入；同时意味着能读到页面内存的攻击面（如 XSS）也能读到密码。这是「断线不掉房」可用性换来的已知取舍，不是疏漏
- **改密不驱逐已在房内的成员**（见「房主权限」）；要清人用踢人
- **旧版 `/token` 回落仍可让自报 deviceId 拿到连接 token**（向后兼容）：这种连接可做信令/文件转发，但不能进房间
- **`tokenSecret` 省略时宿主每次启动随机生成**：WS token 校验始终开启（`apply()` 里 `config.tokenSecret ?? randomBytes(32)`），代价是每次重启后所有旧 token 失效；要跨重启保持 token 稳定请显式配置
- **聊天历史只存宿主进程内存**（每房最多 1000 条、单条最长 10000 字符），不持久化；房间关闭后历史不立即删除，房号被复用时新房间会接续同一聊天室（已知限制）

---

## 房间 Git 工作区同步

房主给房间配一个 **http(s)** Git 仓库，房间成员各自把**宿主本机的一个工作区目录**绑定到该房间；AI 在该目录里改完文件（一个 AI 回合结束）后，插件**默认**把这些改动提交并推送到房间仓库。手动「立即同步」始终可用，失败一定可见（状态里带错误），绝不静默。

### 流程

1. 房主建房时（`repo?` 字段）或进房后（`room-git-config` / `PUT /rooms/:roomId/git`）配置远端、分支、令牌与自动提交/自动推送开关；不配置房间照常可用，只是没有同步
2. 成员把本机工作区目录绑定到房间：服务端校验「绝对路径 + 存在 + 是目录」后，把该目录初始化为 Git 仓库（还不是仓库则 `git init`）、把 `origin` 设为房间远端
3. AI 回合结束时宿主 `workspace/changes` 事件带出本次变更的 `cwd` 与文件数；命中某个绑定目录即按 `debounceMs`（默认 1500ms）合并触发一次同步：暂存全部改动（新增/修改/删除）→ **有变化才提交** → 按 `autoPush` 推送
4. 结果（含失败）写进该绑定的 `lastSync` 并广播 `room-git-sync-result`；`autoPush: false` 时只提交不推送（`pushed: false`）
5. 手动同步不受 `autoCommit` 影响（手动 = 用户明确要求，仍会提交）；`autoCommit: false` 只跳过自动触发

提交信息形如 `chore(cross-transfer): <房间名或 roomId> 自动同步 <N> 个文件`，`N` 超过 20 时截断展示并附 `…(+K)`。同一绑定的同步按 `roomId + deviceId` 串行：运行期间来的触发只置脏标记，结束后补跑一次，不会并发跑两次 git。

### 配置项（`roomGit`，整块可省略）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关；`false` 时配置/清空/绑定/解绑/同步一律 `403 forbidden`（读取不受影响） |
| `debounceMs` | number | `1500` | 自动同步的合并窗口（毫秒） |
| `pushTimeoutMs` | number | `60000` | 单次提交+推送的超时（毫秒） |
| `maxBindingsPerRoom` | number | `16` | 每房间最多保留的绑定数；同设备重复绑定算更新，超限 → `400 invalid-argument` |
| `maxCandidates` | number | `50` | 候选工作区目录的返回上限 |

### REST 路由

| 方法 | 路径 | 鉴权 | 请求体 | 成功响应 |
|---|---|---|---|---|
| GET | `/rooms/:roomId/git` | 该房票据 | — | `200 RoomRepoStatus` |
| PUT | `/rooms/:roomId/git` | 房主票据 | `RoomRepoConfigInput` | `200 RoomRepoStatus` |
| DELETE | `/rooms/:roomId/git` | 房主票据 | — | `200 RoomRepoStatus` |
| PUT | `/rooms/:roomId/workspace` | 该房票据 | `{ path: string }` | `200 RoomRepoStatus` |
| DELETE | `/rooms/:roomId/workspace` | 该房票据 | — | `200 RoomRepoStatus` |
| POST | `/rooms/:roomId/git/sync` | 该房票据 | — | `200 { roomId, result: SyncSummary }` |
| GET | `/rooms/:roomId/workspaces` | 该房票据 | — | `200 { roomId, paths: string[] }` |

方法不在表内 → `405`；`:roomId` 形状不合法 → `404`（与既有房间路由一致）。`POST /rooms/create` 的 body 可带可选 `repo: RoomRepoConfigInput`：建房前先做纯校验（不联网、不落盘），失败直接回错误、不建房；建房成功后立即配置仓库。

### WS 消息

| type | 鉴权 | payload | 应答 type | 应答 payload |
|---|---|---|---|---|
| `room-git-config` | 房主（服务层再校验） | `{ roomId, repo: RoomRepoConfigInput }` | `room-git-status` | `RoomRepoStatus` |
| `room-git-clear` | 房主 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-git-status` | 成员 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-bind` | 成员 | `{ roomId, path }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-unbind` | 成员 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-candidates` | 成员 | `{ roomId }` | `room-workspace-candidates` | `{ roomId, paths: string[] }` |
| `room-git-sync` | 成员 | `{ roomId }` | `room-git-sync-result` | `{ roomId, result: SyncSummary }` |

`room-create` 的 payload 可带可选 `repo?: RoomRepoConfigInput`，语义与 REST 建房一致。服务端推送（`deviceId: 'server'`）：`room-git-status`（payload `RoomRepoStatus`，**按接收者逐个投影**，工作区路径只对绑定者本人与房主可见）与 `room-git-sync-result`（payload `{ roomId, deviceId, result }`，广播给房内成员）。被踢/退房时插件顺带清掉该设备在本房的绑定，失败忽略。

### 数据形状

```typescript
/** 配置入参：remoteUrl 允许内嵌 userinfo，会被抽成 auth 并从存储值里剥离 */
interface RoomRepoConfigInput {
  remoteUrl: string          // 必须是 http:// 或 https://
  branch?: string            // 默认 'main'
  auth?: { type: 'token'; token: string; username?: string }
  autoCommit?: boolean       // 默认 true
  autoPush?: boolean         // 默认 true
  commitAuthorName?: string  // 默认 'dsh-cross-transfer'
  commitAuthorEmail?: string // 默认 'cross-transfer@dsh.local'
}

/** 对外投影：绝不包含 token、绝不包含未剥离 userinfo 的 URL */
interface RoomRepoStatus {
  roomId: string
  configured: boolean
  remoteUrl?: string                 // 已剥离 userinfo；未配置时省略
  branch?: string
  authConfigured: boolean
  autoCommit: boolean
  autoPush: boolean
  updatedAt?: number
  updatedByDeviceId?: string         // 脱敏
  bindings: WorkspaceBindingStatus[]
}

interface WorkspaceBindingStatus {
  deviceId: string                   // 脱敏
  deviceName: string
  bound: boolean
  workspacePath?: string             // 只对绑定者本人与房主返回真实路径
  repoReady?: boolean
  lastSync?: SyncSummary
}

interface SyncSummary {
  at: number
  ok: boolean
  trigger: 'auto' | 'manual'
  committed: number                  // 本次提交的文件数（含删除）
  commitOid?: string
  pushed: boolean
  error?: string
}
```

### 安全边界

- **token 只在宿主进程内存里**：`auth.token` 不落盘、不进任何响应/推送/日志；绑定工作区时也**不写** `credential.helper`（旧仓库注册路径会把明文 token 写进 `.git/config`，这条新路径只走内存回调）
- **URL 脱敏**：远端 URL 内嵌的 userinfo（`https://user:token@host/…`）会被抽取成 `auth` 并从存储值与所有投影里剥离；同时给 `auth` 与内嵌 userinfo → `400 invalid-repo`。`RoomInfo` 只暴露布尔位 `repoConfigured`，连 URL 都不给
- **路径只对本人与房主可见**：`WorkspaceBindingStatus.workspacePath` 只对绑定者本人与房主返回真实宿主路径，其他成员看到 `undefined`；广播按会话逐个投影，不会把别人的宿主目录发给全房间
- **仅 http(s)**：isomorphic-git 只实现了 http(s) 传输，`remoteUrl` 只接受 `http://` / `https://`（其余协议 → `400 invalid-repo`），SSH 未实现
- **非快进 push 会失败**：不做自动 pull、不做冲突合并。远端有新提交时 push 被拒，结果里 `ok=false` 且带错误文本（截断到 500 字符），需要用户手动 `git pull` 后重新同步；提交仍然落在本地
- **凭据即写权限**：token 泄露等同该远端仓库的写权限泄露；没有 token 轮换 UI，换令牌等于重新配置仓库

### 明确不做（v1 范围外）

- SSH 远端、本地目录 / `file://` 远端（isomorphic-git 不支持）
- 自动 pull / 自动解决冲突 / 非快进合并（失败可见，交给用户手动 pull）
- 文件级实时（每次 write）同步：只在 AI 回合结束时按 `workspace/changes` 触发
- 浏览器选择宿主目录的原生文件对话框（浏览器拿不到宿主路径，用候选列表 + 文本输入）
- 变更历史 / 回滚 UI

---

## WebSocket 连接

```
ws://host:port/api/cross-transfer?deviceId=xxx&deviceName=xxx&token=xxx&capabilities=file-transfer,chat,git-sync
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `deviceId` | 否 | 设备 id；省略时服务端生成 16 位 hex。**房间功能要求它来自 `/devices/register` 铸发的凭据** |
| `deviceName` | 否 | 设备显示名；默认 `Device-<deviceId 前 6 位>` |
| `token` | 是 | `sha256("<deviceId>:<tokenSecret>")` 的 hex；校验失败连接被关闭（close code `4001`，reason `Invalid token`）。`tokenSecret` 在配置中省略时宿主**每次启动随机生成**——校验同样开启，只是每次重启后旧 token 全部失效（客户端会自动重新换取） |
| `capabilities` | 否 | 逗号分隔的能力列表；默认 `file-transfer,chat,git-sync` |

`token` 的获取方式（推荐顺序）：

1. `POST /devices/register` —— 返回体直接带 `token`
2. `POST /devices/token`，`Authorization: Bearer <deviceSecret>` —— 换取同一 token

## WS 消息协议

所有帧共用一个信封：

```typescript
interface WSMessage {
  type: string
  sessionId?: string
  deviceId?: string
  targetDeviceId?: string   // 定向转发目标
  payload: unknown
  messageId?: string        // 请求/应答配对键
}
```

- 请求帧带 `messageId` 时，针对它产生的应答帧与错误帧**原样回显** `messageId`（客户端 `request()` 靠它配对）
- JSON 解析失败回旧格式：`{ type: 'error', sessionId, payload: 'Invalid message format' }`（字符串 payload）

### 客户端 → 服务端（房间与聊天，全部经门禁）

所有行都先要求「连接已通过 token 校验」。`room-create` / `room-join` 还要求设备已登记凭据（否则 `invalid-device`）。

| type | 附加鉴权 | payload | 应答 type | 应答 payload |
|---|---|---|---|---|
| `room-create` | 已登记设备 | `{ roomId?, name?, password, maxMembers?, discoverable?, repo? }`（`repo` 为可选 `RoomRepoConfigInput`） | `room-created` | `RoomJoinResult` |
| `room-join` | 已登记设备 | `{ roomId, password }` | `room-joined` | `RoomJoinResult` |
| `room-leave` | 该会话是成员 | `{ roomId }` | `room-left` | `RoomLeaveResult`（同设备其它会话另收一帧 `room-left`） |
| `room-close` | 房主 | `{ roomId }` | `room-closed` | `{ roomId, reason: 'closed-by-owner' }` |
| `room-kick` | 房主 | `{ roomId, deviceId }`（**真实 deviceId**，从 room-members 房主视角响应或踢人广播里拿） | `room-member-kicked` | `{ roomId, deviceId, kickedByDeviceId }` |
| `room-password` | 房主 | `{ roomId, password }` | `room-password-changed` | `{ roomId }` |
| `room-lock` | 房主 | `{ roomId, locked }` | `room-locked` | `{ roomId, locked }` |
| `room-list` | 无（`allowRoomList=false` → `forbidden`） | 忽略 | `room-list` | `{ rooms: RoomInfo[] }` |
| `room-members` | 该会话是成员 | `{ roomId }` | `room-members` | `{ roomId, members }`（房主视角含真实 deviceId，普通成员为脱敏值） |
| `chat-message` | 该会话是成员 | `{ roomId, content, type?, metadata?, replyTo? }`（`type` ∈ `text`/`code`/`file`，默认 `text`；content 非空、≤10000 字符） | `chat-message-ack` | `ChatMessage`（落库后，只回发送会话） |
| `chat-history-request` | 该会话是成员 | `{ roomId, limit? }`（limit 为 1~1000 整数，默认 100） | `chat-history` | `{ roomId, messages: ChatMessage[] }` |
| `typing` | 该会话是成员 | `{ roomId, isTyping }` | （无应答） | — |
| `room-git-config` | 该会话是成员（房主才能成功，否则 `forbidden`） | `{ roomId, repo: RoomRepoConfigInput }` | `room-git-status` | `RoomRepoStatus` |
| `room-git-clear` | 该会话是成员（房主） | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-git-status` | 该会话是成员 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-bind` | 该会话是成员 | `{ roomId, path }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-unbind` | 该会话是成员 | `{ roomId }` | `room-git-status` | `RoomRepoStatus` |
| `room-workspace-candidates` | 该会话是成员 | `{ roomId }` | `room-workspace-candidates` | `{ roomId, paths: string[] }` |
| `room-git-sync` | 该会话是成员 | `{ roomId }` | `room-git-sync-result` | `{ roomId, result: SyncSummary }` |

未列出的 `room-*` 类型或 payload 带 `roomId` 的自定义 type → `error{ code: 'invalid-argument' }`，绝不放行。

**非房间消息保持原行为**：命中内置 handler（`ping`、`file-offer/answer/chunk/complete`、`git-sync-request/response`、`webrtc-offer/answer/candidate`）按其逻辑处理，否则按 `targetDeviceId` 定向转发或全体广播（排除发送者）。

### 服务端 → 客户端推送

| type | 目标 | payload |
|---|---|---|
| `welcome` | 新会话 | `{ sessionId, deviceId, deviceName, capabilities }` |
| `peer-connected` / `peer-disconnected` | 同设备其它会话 | `{ sessionId, deviceId, deviceName }` / `{ sessionId }` |
| `device-connected` / `device-disconnected` | 全体 | `{ deviceId, deviceName, capabilities }` / `{ deviceId }` |
| `user-joined` | 房内成员会话，**排除加入者自己的会话** | `{ roomId, deviceId, deviceName, role }` |
| `user-left` | 剩余成员会话 | `{ roomId, deviceId, reason: 'left' \| 'disconnected' }` |
| `room-member-kicked` | 被踢者会话 ∪ 剩余成员会话 | `{ roomId, deviceId, kickedByDeviceId }` |
| `room-closed` | 关房时的成员会话 | `{ roomId, reason: 'closed-by-owner' \| 'owner-left' \| 'idle-timeout' }` |
| `room-locked` | 成员会话 | `{ roomId, locked }` |
| `room-password-changed` | 成员会话 | `{ roomId }` |
| `owner-changed` | 成员会话 | `{ roomId, newOwnerDeviceId }` |
| `chat-message` | 房内成员会话，排除发送会话 | `ChatMessage` |
| `typing` | 房内成员会话，排除发送会话 | `{ roomId, deviceId, deviceName, isTyping }` |
| `room-git-status` | 房内成员会话（**逐会话投影**，路径只对本人与房主可见） | `RoomRepoStatus` |
| `room-git-sync-result` | 房内成员会话 | `{ roomId, deviceId, result: SyncSummary }` |
| `pong` | 发起 `ping` 的会话 | 时间戳（number） |

### 错误帧

```json
{ "type": "error", "sessionId": "…", "messageId": "…", "payload": { "code": "room-locked", "message": "Room is locked", "retryAfterMs": 120000 } }
```

- `retryAfterMs` 仅 `too-many-attempts` 出现
- `code` 取值（`RoomErrorCode` 全表）：`room-not-found` / `room-exists` / `room-closed` / `room-full` / `room-locked` / `too-many-rooms` / `room-code-exhausted` / `invalid-room-id` / `invalid-password` / `invalid-argument` / `wrong-password` / `invalid-ticket` / `invalid-device` / `too-many-attempts` / `not-a-member` / `forbidden` / `invalid-repo` / `invalid-workspace` / `sync-failed` / `room-gate-unavailable` / `internal-error`
- 门禁未安装时房间消息回 `room-gate-unavailable`（fail-closed）

### 宿主插件订阅者注意（`message` 事件）

WSServer 的 `'message'` 事件对**所有成功解析的帧**都发（含被门禁拒绝的房间帧），它是纯观测事件、不影响网络行为。订阅者现在也能看到房间消息帧及其 payload；其中 `room-create` / `room-join` / `room-password` 三类帧的观测副本里 `password` 字段已被替换为 `'***'`。这是同进程内的插件事件，不是网络面。

## REST API

基址 = `config.path`（默认 `/api/cross-transfer`）。除标注外，房间/身份路由的错误体为 `{ "error": { "code", "message", "retryAfterMs?" } }`。

### 身份与发现

| 方法 | 路径 | 鉴权 | 请求体 | 成功响应 |
|---|---|---|---|---|
| GET | `/devices` | 无 | — | `200 { devices: DeviceInfo[] }` |
| GET | `/sessions` | 无 | — | `200 { sessions: SessionInfo[] }` |
| POST | `/devices/register` | 无 | `{ deviceSecret?, deviceName? }` | `200 { deviceId, deviceSecret, deviceName, token }`；未登记的 secret → `401 invalid-device`；body 里的 `tokenSecret` 一律忽略 |
| POST | `/token` 或 `/devices/token` | 推荐 `Authorization: Bearer <deviceSecret>`；无 Bearer 时回落读 `body.deviceId`（旧兼容，弱凭据，不能进房） | `{ deviceId?, deviceName? }` | `200 { token, deviceId }`；旧回落缺 `deviceId` → `400 { error: 'deviceId required' }`（旧错误体） |

### 房间

| 方法 | 路径 | 鉴权 | 请求体 | 成功响应 |
|---|---|---|---|---|
| POST | `/rooms/create` | `Bearer <deviceSecret>`（缺 → `401 invalid-device`） | `{ roomId?, name?, password, maxMembers?, discoverable?, repo? }`（`repo` 为可选 `RoomRepoConfigInput`，建房前纯校验，失败不建房） | `200 RoomJoinResult`（带 `repo` 时 `room` 为配置后的最新投影） |
| POST | `/rooms/join` | 密码即凭据；body 必须带 `deviceSecret` | `{ roomId, password, deviceSecret, deviceName? }` | `200 RoomJoinResult` |
| GET | `/rooms` | 无 | — | `200 { rooms: RoomInfo[] }`（只含 discoverable 房间，deviceId 脱敏）；`allowRoomList=false` → `403 forbidden` |
| GET | `/rooms/:roomId` | 该房票据 | — | `200 { room: RoomInfo }` |
| GET | `/rooms/:roomId/members` | 该房票据 | — | `200 { roomId, members: RoomMember[] }` |
| POST | `/rooms/:roomId/close` | 房主票据 | `{}` | `200 { roomId, closed: true }` |
| POST | `/rooms/:roomId/password` | 房主票据 | `{ password }` | `200 { roomId, changed: true }` |
| POST | `/rooms/:roomId/lock` | 房主票据 | `{ locked }` | `200 { roomId, locked }` |
| DELETE | `/rooms/:roomId/members/:deviceId` | 该房票据 | — | `200 { roomId, deviceId, removed, self: true }`。**仅支持自助退房**：路径 `deviceId` 必须等于票据持有者，否则 `403 forbidden`；踢人请走 WS `room-kick`（REST 拿不到可比对的真实 id） |
| GET | `/chat/history?roomId=<id>&limit=<n>` | 该房票据 + 仍是成员 | — | `200 { roomId, messages: ChatMessage[] }`；不带票据 → `401 invalid-ticket` |
| GET | `/rooms/:roomId/git` | 该房票据 | — | `200 RoomRepoStatus` |
| PUT | `/rooms/:roomId/git` | 房主票据 | `RoomRepoConfigInput` | `200 RoomRepoStatus` |
| DELETE | `/rooms/:roomId/git` | 房主票据 | — | `200 RoomRepoStatus` |
| PUT | `/rooms/:roomId/workspace` | 该房票据 | `{ path }` | `200 RoomRepoStatus` |
| DELETE | `/rooms/:roomId/workspace` | 该房票据 | — | `200 RoomRepoStatus` |
| POST | `/rooms/:roomId/git/sync` | 该房票据 | — | `200 { roomId, result: SyncSummary }` |
| GET | `/rooms/:roomId/workspaces` | 该房票据 | — | `200 { roomId, paths: string[] }` |

### 既有路由（未变）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/files/initiate` | 发起文件传输 |
| GET / POST | `/git/repos` | 列出 / 注册仓库 |
| POST | `/git/sync` | 触发同步 |

### 404 / 405 边界

- 路径命中房间路由表（`/rooms`、`/rooms/:roomId` 及其 `/members|/close|/password|/lock|/git|/workspace|/workspaces`、`/rooms/:roomId/git/sync`、`/rooms/:roomId/members/:deviceId`）但方法不在表内 → **405** `{ error: { code: 'invalid-argument', message: 'Method not allowed' } }`
- 表未列的 `/rooms/*` 子路径 → **404** `{ error: 'Not found' }`
- 既有路由（`/devices`、`/sessions`、`/files/initiate`、`/git/*`）方法不匹配即落空 → **404**（现状）

### 错误体与状态码

```json
{ "error": { "code": "room-locked", "message": "Room is locked", "retryAfterMs": 120000 } }
```

`retryAfterMs` 仅 `too-many-attempts` 出现，同时写 `Retry-After: <秒>` 响应头。

| code | HTTP |
|---|---|
| `invalid-room-id` / `invalid-password` / `invalid-argument` / `invalid-repo` / `invalid-workspace` | 400 |
| `wrong-password` / `invalid-ticket` / `invalid-device` | 401 |
| `not-a-member` / `forbidden` | 403 |
| `room-not-found` | 404 |
| `room-exists` / `room-full` | 409 |
| `room-closed` | 410 |
| `room-locked` | 423 |
| `too-many-attempts` / `too-many-rooms` | 429 |
| `sync-failed` | 502 |
| `room-code-exhausted` / `room-gate-unavailable` | 503 |
| `internal-error` | 500 |

既有路由的错误体保持 `{ error: '...' }` 字符串形态。

`sync-failed` 是「同步动作本身抛异常」（例如绑定已不存在、仓库未配置）的兜底码：正常的 push/commit 失败**不抛**，而是在 `SyncSummary` 里返回 `ok: false` + `error`。

### 数据形状

```typescript
/** 房间公开投影：不含 sessionId、不含票据、不含任何凭据；ownerDeviceId 已脱敏 */
interface RoomInfo {
  roomId: string
  name: string
  ownerDeviceId: string      // 脱敏：前 4 + '…' + 后 4（长度 < 8 时为 '***'）
  ownerOnline: boolean
  createdAt: number
  lastActivityAt: number
  memberCount: number        // 含离线但保留席位的成员
  maxMembers: number
  locked: boolean
  discoverable: boolean
  repoConfigured: boolean    // 只暴露布尔位，绝不暴露仓库 URL（见「房间 Git 工作区同步」）
}

/** 成员视图。deviceId 脱敏（房主视角的 room-members 响应除外）；sessionIds 永不外泄 */
interface RoomMember {
  deviceId: string
  deviceName: string
  role: 'owner' | 'member'
  joinedAt: number
  sessionCount: number
  online: boolean
}

interface RoomTicket {
  ticket: string             // 64 位 hex
  roomId: string
  deviceId: string
  role: 'owner' | 'member'
  issuedAt: number
  expiresAt: number
}

/** room-create / room-join / POST /rooms/create / POST /rooms/join 的响应体 */
interface RoomJoinResult {
  room: RoomInfo
  member: RoomMember
  ticket: RoomTicket
}

/** room-leave 的响应体 */
interface RoomLeaveResult {
  roomId: string
  deviceId: string
  removed: boolean           // 成员行是否被移除
  closed: boolean            // closeWhenOwnerLeaves=true 且房主退房
  newOwnerDeviceId?: string  // 房主移交时的新房主
}

interface ChatMessage {
  messageId: string
  roomId: string
  senderDeviceId: string
  senderDeviceName: string
  senderSessionId: string
  content: string
  type: 'text' | 'system' | 'file' | 'code'
  metadata?: Record<string, unknown>
  timestamp: number
  edited?: boolean
  replyTo?: string
}

interface DeviceInfo {
  deviceId: string
  deviceName: string
  connectedAt: number
  lastActiveAt: number
  sessionCount: number
  capabilities: string[]
}

interface SessionInfo {
  sessionId: string
  deviceId: string
  deviceName: string
  connectedAt: number
  lastActiveAt: number
}
```

## 客户端（浏览器半）

```typescript
import { CrossTransferClient, RoomPanel } from 'dsh-cross-transfer/client'

const client = new CrossTransferClient(ctx, {
  autoConnect: true,       // 默认 true；挂载后自动换取 token 并连接
  deviceName: 'My Device'
})
```

客户端服务名 `crossTransferClient`。设备凭据全自动管理：首次 `POST /devices/register` 铸发 `deviceSecret` 存入 localStorage（key `dsh-cross-transfer-device-secret`；旧 key `dsh-cross-transfer-device-id` 检测到即废弃），之后每次连接前凭 secret 换 token；宿主重启导致凭据失效时自动重新登记。

### 房间 API

```typescript
await client.createRoom({ roomId?, name?, password, maxMembers?, discoverable?, repo? }) // → ActiveRoom
await client.joinRoom(roomId, password)          // → ActiveRoom
await client.leaveRoom(roomId)
await client.closeRoom(roomId)                   // 仅房主
await client.kickMember(roomId, deviceId)        // deviceId 用广播/成员列表里的真实 id
await client.changeRoomPassword(roomId, password)
await client.setRoomLocked(roomId, locked)
await client.listRooms()                         // → RoomInfo[]
await client.requestRoomMembers(roomId)          // → RoomMember[]
await client.sendChatMessage(roomId, content, type?, metadata?) // → ChatMessage
client.requestChatHistory(roomId, limit?)
client.setTyping(roomId, isTyping)
client.getJoinedRooms()                          // → ActiveRoom[]
client.getActiveRoom()                           // → ActiveRoom | null
client.getRoomPassword(roomId)                   // 仅内存中的密码
await client.setRoomGit(roomId, repo)            // 仅房主；repo: RoomRepoConfigInput → RoomRepoStatus
await client.clearRoomGit(roomId)                // 仅房主 → RoomRepoStatus
await client.getRoomGitStatus(roomId)            // → RoomRepoStatus
await client.bindRoomWorkspace(roomId, path)     // → RoomRepoStatus
await client.unbindRoomWorkspace(roomId)         // → RoomRepoStatus
await client.listWorkspaceCandidates(roomId)     // → string[]
await client.syncRoomGit(roomId)                 // 手动同步 → SyncSummary
client.setActiveRoom(roomId)
await client.ensureDeviceRegistered()
```

`ActiveRoom = { roomId, name, role, ticket, expiresAt }`。

### 事件

| 事件 | 参数 |
|---|---|
| `connected` / `disconnected` | 会话 / sessionId |
| `roomJoined` | `(room: ActiveRoom, member: RoomMember, ticket: RoomTicket)` |
| `roomLeft` | `(roomId)` |
| `roomList` | `(rooms: RoomInfo[])` |
| `roomMembers` | `(roomId, members: RoomMember[])` |
| `roomClosed` | `(roomId, reason)` |
| `roomMemberKicked` | `(roomId, deviceId, kickedByDeviceId)` |
| `roomLocked` | `(roomId, locked)` |
| `roomPasswordChanged` | `(roomId)` |
| `roomGitStatus` | `(status: RoomRepoStatus)`（仅服务端推送形态；带 `messageId` 的应答用于兑现方法 promise） |
| `roomGitSync` | `(roomId, deviceId, result: SyncSummary)`（仅推送形态） |
| `activeRoomChanged` | `(room: ActiveRoom \| null)` |
| `chatMessage` | `(message: ChatMessage)` |
| `chatHistory` | `(messages: ChatMessage[])` |
| `chatUserJoined` / `chatUserLeft` | `(roomId, deviceId, …)` |
| `chatTyping` | `(roomId, deviceId, deviceName, isTyping)` |
| `peerConnected` / `peerDisconnected` | `(peer)` |
| `deviceList` | `(devices)` |
| `error` | `(error)` |
| `fileOffer` / `fileProgress` / `fileComplete` / `fileError` | 文件传输 |
| `syncProgress` / `syncComplete` / `syncError` / `syncConflict` / `repoList` | Git 同步 |

房间操作的失败以 `RoomRequestError` 抛出（`code: RoomErrorCode`、可选 `retryAfterMs`），或通过 `error` 事件上报。错误帧 payload 是旧格式字符串时降级为普通 `Error`。

### 断线恢复行为

- 断线后 3s 退避自动重连（重连前自动重新换 token）
- 连接成功（收到 `welcome`）后，对内存里存有密码的每个房间自动重发 `room-join`；失败只上报 `error`，不无限重试
- 房间操作返回 `invalid-ticket` 时，若内存里还有该房密码则自动重进一次再重试原操作；没有密码则只上报错误
- 页面刷新会丢失内存密码：需要用户重新进房（见「安全边界与已知取舍」）

### UI 组件

- `RoomPanel`：建房/进房表单、已加入房间列表、成员列表（在线位 + 房主标记 + 踢人）、房主操作（改密/锁房/关房）、可发现房间列表、错误提示（含 `retryAfterMs` 倒数）；建房表单含折叠区「Git 仓库（可选）」，房内另有「仓库与工作区」区块（房主配仓库、成员绑定本机工作区 + 候选目录 `datalist` + 绑定/解绑/立即同步、成员同步状态列表）
- `ChatPanel`：**独立聊天窗**，左右两栏——左栏已加入的房间列表（点击即切换当前房间），右栏会话。消息按 `text` / `code` / `file` / `system` 四种类型分别渲染（代码块等宽字体、文件带 📎 与可读元信息、系统消息居中），跨天插入日期分隔线，显示 typing 与「正在输入…」，Enter 发送 / Shift+Enter 换行；未连接时输入框禁用。未进房时只给引导，不订阅、不请求历史
- `ChatLauncher`：侧边栏底部的 💬 入口，点击打开上述聊天窗。与 ⇄ Cross Transfer 是**同一个 `sidebar.footer.action` 列表插槽上的两条独立条目**（`id` 分别为 `cross-transfer-chat-panel` / `cross-transfer-panel`），各自开合，且**互斥**——两个面板都锚在侧边栏脚部（同一个 `position: fixed` 位置），同时开会整块互相盖住，所以开一个就请另一个关掉
- `CrossTransferUI`：Cross Transfer 悬浮窗本体，含 `Files` / `Rooms` / `Git Sync` 三个页签（聊天已独立出去）
- 其余面板：`FileTransferPanel`、`GitSyncPanel`、`DeviceList`

两个悬浮窗之间唯一的耦合是 `panelBridge`：聊天窗空状态的「打开 Cross Transfer 面板」按钮需要一个跳到房间面板的入口，互斥也需要跨面板通信，而两个 launcher 的 React 树彼此独立，只能走这条模块级注册表（`registerTransferOpener` / `openTransferPanel` / `registerPanelCloser` / `closeOtherPanels`）。它不持有任何聊天或房间状态，卸载时按引用自动注销。

## 配置参考

顶层配置：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `path` | string | `'/api/cross-transfer'` | REST 前缀与 WS 路径（无尾斜杠） |
| `tokenSecret` | string | 启动时随机生成 | 设备 token 的共享密钥：`token = sha256(deviceId + ':' + tokenSecret)`。省略时每次启动随机生成（重启后旧 token 全部失效，客户端自动重新换取）；显式配置可跨重启稳定 |
| `maxFileSize` | number | `1073741824` | 单文件大小上限（1GB） |
| `chunkSize` | number | `1048576` | 文件分片大小（1MB） |
| `rooms` | object | 见下 | 房间机制配置；整块可省略 |
| `roomGit` | object | 见下 | 房间 Git 工作区同步配置；整块可省略 |

`rooms` 配置块（13 项，全部有默认值，可部分覆盖）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `maxRooms` | number | `100` | 全局房间总数上限（含建房占位） |
| `maxRoomsPerDevice` | number | `5` | 每台设备可拥有的房间数上限 |
| `maxMembersPerRoom` | number | `16` | 单房间成员上限（建房传入的 `maxMembers` 被夹到 `[1, 此值]`） |
| `roomCodeLength` | number | `6` | 随机房号位数，4~12（越界拒绝加载） |
| `minPasswordLength` | number | `6` | 密码最小长度（上限固定 128） |
| `maxJoinAttempts` | number | `8` | 限流窗口内允许的进房失败次数 |
| `joinAttemptWindowMs` | number | `60000` | 限流窗口（60s） |
| `joinLockoutMs` | number | `120000` | 触发限流后的锁定时长（2min） |
| `ticketTtlMs` | number | `86400000` | 房间票据有效期（24h） |
| `idleTtlMs` | number | `1800000` | 空闲回收阈值（30min） |
| `closeWhenOwnerLeaves` | boolean | `true` | 房主退房即关房；`false` 则自动移交房主 |
| `discoverableByDefault` | boolean | `true` | 建房默认出现在房间列表 |
| `allowRoomList` | boolean | `true` | 是否开放房间列表；`false` 时 REST `/rooms` 与 WS `room-list` 一律 `403 forbidden` |

`roomGit` 配置块（5 项，全部有默认值，可部分覆盖；`enabled: false` 时所有写操作 `403 forbidden`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 房间 Git 工作区同步总开关 |
| `debounceMs` | number | `1500` | 自动同步的合并窗口（毫秒） |
| `pushTimeoutMs` | number | `60000` | 单次提交+推送的超时（毫秒） |
| `maxBindingsPerRoom` | number | `16` | 每房间最多保留的绑定数（同设备重复绑定算更新） |
| `maxCandidates` | number | `50` | 候选工作区目录的返回上限 |

## 开发

```bash
# 安装依赖
pnpm install

# 构建（tsdown + 客户端包装）
pnpm run bundle

# 监听模式
pnpm run watch

# 类型检查
pnpm run typecheck

# 测试
pnpm test
```

## License

MIT
