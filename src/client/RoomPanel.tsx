import React, { useState, useEffect, useCallback } from 'react'
import {
  CrossTransferClient,
  RoomRequestError,
  type ActiveRoom,
  type ChatMessage,
  type RoomRepoConfigInput,
  type RoomRepoStatus,
  type SyncSummary
} from './CrossTransferClient.js'
import type { RoomErrorCode, RoomInfo, RoomMember, RoomRole } from '../rooms.js'

interface RoomPanelProps {
  client: CrossTransferClient
}

/** 活跃房间 = 已加入 + 当前选中。两个来源合流成一个值，避免两处状态打架。 */
interface JoinedView extends ActiveRoom {
  active: boolean
}

/**
 * 服务端 code → 人话。写在客户端而不是服务端：同一份 code 在 REST 与 WS 面
 * 都出现，服务端只承诺 code 稳定，文案属于展示层。
 */
const ERROR_TEXT: Record<RoomErrorCode, string> = {
  'room-not-found': '房间不存在，请确认 4~12 位数字房号',
  'room-exists': '该房号已被占用，换一个或留空自动生成',
  'room-closed': '房间已关闭',
  'room-full': '房间已满',
  'room-locked': '房间已锁定，暂时不能加入',
  'too-many-rooms': '房间数量已达上限，请先关掉一个',
  'room-code-exhausted': '自动生成房号失败，请手动指定一个',
  'invalid-room-id': '房号格式不对，必须是 4~12 位数字',
  'invalid-password': '密码格式不对：至少 6 位、至多 128 位',
  'invalid-argument': '请求参数不合法，请检查表单',
  // 房间 Git 工作区同步（契约 §4.3）：这三个 code 由服务端给出，文案属于展示层。
  'invalid-repo': '仓库地址不合法，必须是 http:// 或 https://',
  'invalid-workspace': '工作区目录不合法，请确认路径存在且是目录',
  'sync-failed': '同步失败，请检查仓库地址、分支与访问令牌',
  'wrong-password': '密码错误',
  'invalid-ticket': '进房凭据已失效，请重新进房',
  'invalid-device': '设备身份未登记，请刷新页面重新连接',
  'too-many-attempts': '尝试过多，请稍后再试',
  'not-a-member': '你不在这个房间里',
  'forbidden': '没有权限执行这个操作（只有房主可以）',
  'room-gate-unavailable': '服务端未启用房间门禁，无法使用房间功能',
  'internal-error': '服务端内部错误，请稍后再试',
}

/**
 * 把 RoomError 翻成中文。`retryAfterMs` 只在限流锁定时出现，所以只有它带倒数；
 * 其余情况按 5 秒定时器让调用方重算文案。
 */
function formatRoomError(error: unknown): string {
  if (error instanceof RoomRequestError) {
    const base = ERROR_TEXT[error.code] ?? error.code
    if (error.code === 'too-many-attempts') {
      const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 0) / 1000))
      return `${base}：还需等待 ${seconds} 秒`
    }
    return base
  }
  return error instanceof Error ? error.message : String(error)
}

/** 主动重试延迟：唯一需要等的是限流锁定，其余错误等一秒只是避免用户狂点。 */
function retryDelay(error: unknown): number {
  if (error instanceof RoomRequestError && error.code === 'too-many-attempts') {
    return error.retryAfterMs ?? 0
  }
  return 1000
}

/**
 * 剩余秒数。第一次渲染就取整、之后每秒重算 —— 让限流提示真的在倒计时，
 * 而不是把「120 秒」冻在屏幕上。
 */
function Countdown({ until }: { until: number }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick(tick => tick + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((until - Date.now()) / 1000))
  return <span>{seconds}</span>
}

/** 房主判断：列表里的 ownerDeviceId 是脱敏值，比较前先同样脱敏，绝不外传真值。 */
function maskDeviceId(deviceId: string): string {
  if (deviceId.length < 8) return '***'
  return `${deviceId.slice(0, 4)}…${deviceId.slice(-4)}`
}

function isOwnerOf(room: RoomInfo | undefined, deviceId: string): boolean {
  return !!room && room.ownerDeviceId === maskDeviceId(deviceId)
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const buttonStyle: React.CSSProperties = {
  padding: '6px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '4px',
  background: 'var(--dsw-alias-bg-layer-1)',
  cursor: 'pointer',
  fontSize: '13px'
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-button-primary-fill)',
  color: 'var(--dsw-alias-label-primary-inverted)',
  border: 'none'
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: 'var(--dsw-alias-state-error-primary)',
  color: 'var(--dsw-alias-label-primary-inverted)',
  border: 'none'
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '6px',
  fontSize: '13px',
  fontFamily: 'inherit'
}

const sectionStyle: React.CSSProperties = {
  padding: '12px',
  border: '1px solid var(--dsw-alias-border-l1)',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-2)'
}

const sectionTitleStyle: React.CSSProperties = { margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: 'var(--dsw-alias-label-primary)' }

/** 表单字段标签：与建房表单里内联的 label 样式保持一致，抽出来给仓库表单复用。 */
const fieldLabelStyle: React.CSSProperties = { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }

/**
 * 房间面板：建房、进房、房间列表、成员与房主操作。
 *
 * 密码/哈希在这个面板里只以「输入」形态存在 —— 输入框 type=password，且没有任何
 * 把密码写进列表或成员视图的代码路径；确认密码只在本地比对，不上行。
 */
export const RoomPanel: React.FC<RoomPanelProps> = ({ client }) => {
  // 建房表单
  const [createRoomId, setCreateRoomId] = useState('')
  const [createName, setCreateName] = useState('')
  const [createPassword, setCreatePassword] = useState('')
  const [createConfirm, setCreateConfirm] = useState('')
  const [createMaxMembers, setCreateMaxMembers] = useState('16')
  const [createDiscoverable, setCreateDiscoverable] = useState(true)

  // 建房表单的 Git 仓库折叠区（§5.2）：远端为空即「不配置」，令牌提交后立刻从组件状态清掉。
  const [showGitSection, setShowGitSection] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [repoBranch, setRepoBranch] = useState('main')
  const [repoToken, setRepoToken] = useState('')
  const [repoAutoPush, setRepoAutoPush] = useState(true)

  // 进房表单
  const [joinRoomId, setJoinRoomId] = useState('')
  const [joinPassword, setJoinPassword] = useState('')

  // 房间数据
  const [listedRooms, setListedRooms] = useState<RoomInfo[]>([])
  const [joinedRooms, setJoinedRooms] = useState<JoinedView[]>([])
  const [membersByRoom, setMembersByRoom] = useState<Record<string, RoomMember[]>>({})
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)

  // 仓库与工作区（§5.2）：状态按房间存本地视图，推送与请求结果都写回这里。
  const [gitStatusByRoom, setGitStatusByRoom] = useState<Record<string, RoomRepoStatus>>({})
  const [workspacePath, setWorkspacePath] = useState('')
  const [workspaceCandidates, setWorkspaceCandidates] = useState<string[]>([])
  const [editingRepo, setEditingRepo] = useState(false)

  // 房主操作
  const [newPassword, setNewPassword] = useState('')
  const [confirmNewPassword, setConfirmNewPassword] = useState('')

  // 提示
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [notices, setNotices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [refreshRoomId, setRefreshRoomId] = useState('')
  const [retryUntil, setRetryUntil] = useState<number | null>(null)

  const activeRoomId = selectedRoomId ?? joinedRooms.find(room => room.active)?.roomId ?? null
  const selectedRoom = joinedRooms.find(room => room.roomId === activeRoomId)
  const selectedRoomInfo = listedRooms.find(room => room.roomId === activeRoomId)
  const selectedMembers = activeRoomId ? membersByRoom[activeRoomId] ?? [] : []
  // 当前房间的仓库状态；还没拉到时是 undefined，UI 用「正在读取」占位。
  const activeGitStatus = activeRoomId ? gitStatusByRoom[activeRoomId] : undefined
  // 房主身份取「列表投影」与「已加入房间」两处之一：列表不一定可见（不可发现的房间）。
  const isOwner = isOwnerOf(selectedRoomInfo, client.getDeviceId()) || selectedRoom?.role === 'owner'
  const errorList = Object.entries(errors)

  const markBusy = (key: string, value: boolean) => setBusy(prev => ({ ...prev, [key]: value }))
  const setError = (key: string, message: string | null) =>
    setErrors(prev => {
      const next = { ...prev }
      if (message === null) delete next[key]
      else next[key] = message
      return next
    })
  const setNotice = (key: string, message: string | null) =>
    setNotices(prev => {
      const next = { ...prev }
      if (message === null) delete next[key]
      else next[key] = message
      return next
    })

  const refreshRooms = useCallback(async () => {
    try {
      setListedRooms(await client.listRooms())
      setError('list', null)
    } catch (error) {
      // 列表被关掉（allowRoomList=false）是正常配置，不是故障。
      setError('list', formatRoomError(error))
    }
  }, [client])

  const refreshMembers = useCallback(async (roomId: string) => {
    try {
      const members = await client.requestRoomMembers(roomId)
      setMembersByRoom(prev => ({ ...prev, [roomId]: members }))
    } catch (error) {
      setError('members', formatRoomError(error))
    }
  }, [client])

  /** 拉一次仓库状态（§5.2：进入房间时调一次；之后由推送维护）。 */
  const refreshGitStatus = useCallback(async (roomId: string) => {
    try {
      const status = await client.getRoomGitStatus(roomId)
      setGitStatusByRoom(prev => ({ ...prev, [roomId]: status }))
      setError('git', null)
    } catch (error) {
      setError('git', formatRoomError(error))
    }
  }, [client])

  /** 候选目录来自宿主依赖，缺失时服务契约规定返回空数组；这里再兜底一次，不让 UI 报错。 */
  const refreshCandidates = useCallback(async (roomId: string) => {
    try {
      setWorkspaceCandidates(await client.listWorkspaceCandidates(roomId))
    } catch {
      setWorkspaceCandidates([])
    }
  }, [client])

  const syncJoined = useCallback(() => {
    const active = client.getActiveRoom()
    setJoinedRooms(client.getJoinedRooms().map(room => ({ ...room, active: room.roomId === active?.roomId })))
  }, [client])

  useEffect(() => {
    const handleJoined = (room: ActiveRoom) => {
      syncJoined()
      setSelectedRoomId(room.roomId)
      void refreshMembers(room.roomId)
    }
    const handleLeft = () => {
      syncJoined()
      setSelectedRoomId(null)
    }
    const handleActive = () => syncJoined()
    const handleClosed = (roomId: string) => {
      setNotice('room', `房间 ${roomId} 已关闭`)
      setMessagesForClosedRoom(roomId)
      syncJoined()
    }
    const handleKicked = (roomId: string, _deviceId: string, _kickedBy: string) => {
      setNotice('room', `你已被移出房间 ${roomId}`)
      setMessagesForClosedRoom(roomId)
      syncJoined()
    }
    const handleLocked = (roomId: string, locked: boolean) => {
      setListedRooms(prev => prev.map(room => (room.roomId === roomId ? { ...room, locked } : room)))
    }
    const handleList = (rooms: RoomInfo[]) => setListedRooms(rooms)
    const handleMembers = (roomId: string, members: RoomMember[]) =>
      setMembersByRoom(prev => ({ ...prev, [roomId]: members }))
    const handleError = (error: Error) => {
      setError('transport', formatRoomError(error))
      setRetryUntil(Date.now() + retryDelay(error))
    }

    // 关房/被踢后把本地残留的成员列表清掉，否则会一直显示一个不存在的房间。
    function setMessagesForClosedRoom(roomId: string) {
      setMembersByRoom(prev => {
        const next = { ...prev }
        delete next[roomId]
        return next
      })
    }

    client.on('roomJoined', handleJoined)
    client.on('roomLeft', handleLeft)
    client.on('activeRoomChanged', handleActive)
    client.on('roomClosed', handleClosed)
    client.on('roomMemberKicked', handleKicked)
    client.on('roomLocked', handleLocked)
    client.on('roomList', handleList)
    client.on('roomMembers', handleMembers)
    client.on('error', handleError)

    syncJoined()
    void refreshRooms()

    return () => {
      client.off('roomJoined', handleJoined)
      client.off('roomLeft', handleLeft)
      client.off('activeRoomChanged', handleActive)
      client.off('roomClosed', handleClosed)
      client.off('roomMemberKicked', handleKicked)
      client.off('roomLocked', handleLocked)
      client.off('roomList', handleList)
      client.off('roomMembers', handleMembers)
      client.off('error', handleError)
    }
  }, [client, refreshRooms, refreshMembers, syncJoined])

  // 用户点了「重试」之后，把剩余等待时间显示出来并自动解除。
  useEffect(() => {
    if (retryUntil === null) return
    const timer = setTimeout(() => setRetryUntil(null), Math.max(0, retryUntil - Date.now()))
    return () => clearTimeout(timer)
  }, [retryUntil])

  // 仓库状态按房间存本地视图（§5.2）：room-git-status 是服务端按接收者逐个投影后的推送，
  // 直接覆盖；room-git-sync 只带结果，需要按 deviceId 合并回对应的绑定行。
  useEffect(() => {
    const handleGitStatus = (status: RoomRepoStatus) => {
      setGitStatusByRoom(prev => ({ ...prev, [status.roomId]: status }))
      // 配置变化时同步表单初值，让「修改仓库」打开就是当前值（令牌不回显，始终为空）。
      if (status.configured) {
        setRepoUrl(status.remoteUrl ?? '')
        setRepoBranch(status.branch ?? 'main')
        setRepoAutoPush(status.autoPush)
      }
    }
    const handleGitSync = (roomId: string, deviceId: string, result: SyncSummary) => {
      setGitStatusByRoom(prev => {
        const status = prev[roomId]
        if (!status) return prev
        // 推送里的 deviceId 可能是真值也可能是脱敏值，统一脱敏后再比对。
        const masked = maskDeviceId(deviceId)
        const bindings = status.bindings.map(binding =>
          binding.deviceId === masked ? { ...binding, lastSync: result } : binding
        )
        return { ...prev, [roomId]: { ...status, bindings } }
      })
    }
    client.on('roomGitStatus', handleGitStatus)
    client.on('roomGitSync', handleGitSync)
    return () => {
      client.off('roomGitStatus', handleGitStatus)
      client.off('roomGitSync', handleGitSync)
    }
  }, [client])

  // 进入/切换房间时各拉一次状态与候选目录（§5.2）。
  useEffect(() => {
    if (!activeRoomId) return
    void refreshGitStatus(activeRoomId)
    void refreshCandidates(activeRoomId)
  }, [activeRoomId, refreshGitStatus, refreshCandidates])

  const handleCreate = async () => {
    const roomId = createRoomId.trim()
    if (roomId && !/^\d{4,12}$/.test(roomId)) {
      setError('create', '房号必须是 4~12 位纯数字，或留空自动生成')
      return
    }
    if (createPassword.length < 6) {
      setError('create', '密码至少 6 位')
      return
    }
    if (createPassword !== createConfirm) {
      setError('create', '两次输入的密码不一致')
      return
    }
    const maxMembers = Number.parseInt(createMaxMembers, 10)
    if (createMaxMembers.trim() !== '' && (!Number.isFinite(maxMembers) || maxMembers < 1)) {
      setError('create', '人数上限必须是正整数')
      return
    }
    // 远端为空 = 不配置仓库：整个 repo 键都不传，服务端据此区分「不配置」与「清空」（§5.2）。
    const trimmedRepoUrl = repoUrl.trim()
    const repo: RoomRepoConfigInput | undefined = trimmedRepoUrl === '' ? undefined : {
      remoteUrl: trimmedRepoUrl,
      branch: repoBranch.trim() || undefined,
      ...(repoToken.trim() === '' ? {} : { auth: { type: 'token' as const, token: repoToken.trim() } }),
      autoPush: repoAutoPush
    }
    markBusy('create', true)
    try {
      const room = await client.createRoom({
        roomId: roomId || undefined,
        name: createName.trim() || undefined,
        password: createPassword,
        maxMembers: createMaxMembers.trim() === '' ? undefined : maxMembers,
        discoverable: createDiscoverable,
        repo
      })
      // 建完立刻把明文从组件状态里丢掉，页面不再持有密码。
      setCreatePassword('')
      setCreateConfirm('')
      setCreateRoomId('')
      // 令牌同样只该活到提交这一刻，建完就丢掉。
      setRepoToken('')
      setSelectedRoomId(room.roomId)
      setError('create', null)
      setNotice('create', `房间 ${room.roomId} 已创建`)
      void refreshRooms()
      await refreshMembers(room.roomId)
    } catch (error) {
      setError('create', formatRoomError(error))
    } finally {
      markBusy('create', false)
    }
  }

  const handleJoin = async (roomIdArg?: string, passwordArg?: string) => {
    const roomId = (roomIdArg ?? joinRoomId).trim()
    const password = passwordArg ?? joinPassword
    if (!roomId) {
      setError('join', '请输入房号')
      return
    }
    if (!password) {
      setError('join', '请输入房间密码')
      return
    }
    markBusy('join', true)
    try {
      const room = await client.joinRoom(roomId, password)
      setJoinPassword('')
      setSelectedRoomId(room.roomId)
      setError('join', null)
      setNotice('join', `已加入房间 ${room.roomId}`)
      await refreshMembers(room.roomId)
    } catch (error) {
      setError('join', formatRoomError(error))
      setRetryUntil(Date.now() + retryDelay(error))
    } finally {
      markBusy('join', false)
    }
  }

  /**
   * 通用的「busy + 错误 + 提示」包装。名字不带 owner：房主操作与成员操作
   * （绑定/解绑/立即同步）都走它，它本身不做任何权限判定，权限在服务端。
   */
  const runAction = async (key: string, action: () => Promise<void>, successText: string) => {
    markBusy(key, true)
    try {
      await action()
      setError(key, null)
      setNotice(key, successText)
      setRetryUntil(null)
    } catch (error) {
      setError(key, formatRoomError(error))
      // 服务端把「还要等多久」放在 retryAfterMs 里，交给 Countdown 渲染。
      setRetryUntil(Date.now() + retryDelay(error))
    } finally {
      markBusy(key, false)
    }
  }

  const handleChangePassword = async () => {
    if (!activeRoomId) return
    if (newPassword.length < 6) {
      setError('password', '密码至少 6 位')
      return
    }
    if (newPassword !== confirmNewPassword) {
      setError('password', '两次输入的密码不一致')
      return
    }
    await runAction(
      'password',
      () => client.changeRoomPassword(activeRoomId, newPassword),
      '密码已更新（已在房内的成员不受影响，仅影响之后的新加入者）'
    )
    setNewPassword('')
    setConfirmNewPassword('')
  }

  /** 组装 RoomRepoConfigInput；远端为空返回 null（调用方据此提示，不发出半配置请求）。 */
  const buildRepoConfig = (autoPush: boolean): RoomRepoConfigInput | null => {
    const remoteUrl = repoUrl.trim()
    if (remoteUrl === '') return null
    const token = repoToken.trim()
    return {
      remoteUrl,
      branch: repoBranch.trim() || undefined,
      ...(token === '' ? {} : { auth: { type: 'token' as const, token } }),
      autoPush
    }
  }

  const handleSaveRepo = async () => {
    if (!activeRoomId) return
    const repo = buildRepoConfig(repoAutoPush)
    if (!repo) {
      setError('git', '请填写远端 URL')
      return
    }
    await runAction('git', async () => {
      const status = await client.setRoomGit(activeRoomId, repo)
      setGitStatusByRoom(prev => ({ ...prev, [activeRoomId]: status }))
      // 令牌只在内存里用过一次，保存后立刻丢掉，不留在组件状态里。
      setRepoToken('')
      setEditingRepo(false)
    }, '仓库配置已保存')
  }

  const handleClearRepo = async () => {
    if (!activeRoomId) return
    await runAction('git', async () => {
      const status = await client.clearRoomGit(activeRoomId)
      setGitStatusByRoom(prev => ({ ...prev, [activeRoomId]: status }))
      setRepoToken('')
      setEditingRepo(false)
    }, '仓库配置已清除')
  }

  const handleSetAutoPush = async (autoPush: boolean) => {
    if (!activeRoomId) return
    const repo = buildRepoConfig(autoPush)
    if (!repo) return
    await runAction('git', async () => {
      const status = await client.setRoomGit(activeRoomId, repo)
      setGitStatusByRoom(prev => ({ ...prev, [activeRoomId]: status }))
    }, '自动推送已更新')
  }

  const handleBindWorkspace = async () => {
    if (!activeRoomId) return
    const path = workspacePath.trim()
    if (path === '') {
      setError('workspace', '请填写工作区路径')
      return
    }
    await runAction('workspace', async () => {
      const status = await client.bindRoomWorkspace(activeRoomId, path)
      setGitStatusByRoom(prev => ({ ...prev, [activeRoomId]: status }))
    }, '工作区已绑定')
  }

  const handleUnbindWorkspace = async () => {
    if (!activeRoomId) return
    await runAction('workspace', async () => {
      const status = await client.unbindRoomWorkspace(activeRoomId)
      setGitStatusByRoom(prev => ({ ...prev, [activeRoomId]: status }))
    }, '工作区已解绑')
  }

  const handleSyncNow = async () => {
    if (!activeRoomId) return
    await runAction('sync', async () => {
      const result = await client.syncRoomGit(activeRoomId)
      // 推送也会带回同一份结果；先用返回值落一次本地视图，省掉等一帧的闪烁。
      setGitStatusByRoom(prev => {
        const status = prev[activeRoomId]
        if (!status) return prev
        const me = maskDeviceId(client.getDeviceId())
        const bindings = status.bindings.map(binding =>
          binding.deviceId === me ? { ...binding, lastSync: result } : binding
        )
        return { ...prev, [activeRoomId]: { ...status, bindings } }
      })
    }, '同步请求已完成')
  }

  /** 仓库配置字段（远端/分支/令牌/自动推送）：建房折叠区与房内配置表单共用一份。 */
  const renderRepoFields = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <label style={fieldLabelStyle}>
        远端 URL（http:// 或 https://）
        <input
          value={repoUrl}
          onChange={e => setRepoUrl(e.target.value)}
          placeholder="https://github.com/owner/repo.git"
          style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
        />
      </label>
      <label style={fieldLabelStyle}>
        分支
        <input
          value={repoBranch}
          onChange={e => setRepoBranch(e.target.value)}
          placeholder="main"
          style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
        />
      </label>
      <label style={fieldLabelStyle}>
        访问令牌
        <input
          type="password"
          value={repoToken}
          onChange={e => setRepoToken(e.target.value)}
          placeholder="可选（HTTPS Basic）"
          style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
        />
      </label>
      <label style={{ ...fieldLabelStyle, display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--dsw-alias-label-primary)' }}>
        <input type="checkbox" checked={repoAutoPush} onChange={e => setRepoAutoPush(e.target.checked)} />
        自动推送
      </label>
      <p style={{ margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>
        令牌只在提交时上行，不会写进房间列表或日志。
      </p>
    </div>
  )

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Rooms</h3>
        <button onClick={() => void refreshRooms()} style={buttonStyle}>刷新房间列表</button>
      </div>

      {/* 错误区：code 已翻成人话，限流额外显示倒计时 */}
      {retryUntil !== null && (
        <div style={{ padding: '8px 12px', background: 'var(--dsw-alias-state-warn-tertiary)', color: 'var(--dsw-alias-state-warn-label)', border: '1px solid var(--dsw-alias-state-warn-secondary)', borderRadius: '6px', fontSize: '13px' }}>
          请求被限流，<Countdown until={retryUntil} /> 秒后可以重试。
        </div>
      )}
      {errorList.length > 0 && (
        <div style={{ padding: '8px 12px', background: 'var(--dsw-alias-interactive-bg-hover-danger)', color: 'var(--dsw-alias-state-error-primary)', border: '1px solid var(--dsw-alias-state-error-secondary)', borderRadius: '6px', fontSize: '13px' }}>
          {errorList.map(([key, message]) => <div key={key}>{message}</div>)}
        </div>
      )}
      {Object.entries(notices).map(([key, message]) => (
        <div key={key} style={{ padding: '8px 12px', background: 'var(--dsw-alias-state-success-tertiary)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-state-success-secondary)', borderRadius: '6px', fontSize: '13px' }}>
          {message}
        </div>
      ))}

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* 建房 */}
        <div style={{ ...sectionStyle, flex: '1 1 320px' }}>
          <p style={sectionTitleStyle}>创建房间</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              房号（留空自动生成）
              <input
                value={createRoomId}
                onChange={e => setCreateRoomId(e.target.value)}
                placeholder="4~12 位数字"
                inputMode="numeric"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              房间名
              <input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                placeholder="可选"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              密码
              <input
                type="password"
                value={createPassword}
                onChange={e => setCreatePassword(e.target.value)}
                placeholder="至少 6 位"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              确认密码
              <input
                type="password"
                value={createConfirm}
                onChange={e => setCreateConfirm(e.target.value)}
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              人数上限
              <input
                value={createMaxMembers}
                onChange={e => setCreateMaxMembers(e.target.value)}
                inputMode="numeric"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '13px', color: 'var(--dsw-alias-label-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <input type="checkbox" checked={createDiscoverable} onChange={e => setCreateDiscoverable(e.target.checked)} />
              在房间列表里可见
            </label>
            <button
              onClick={() => void handleCreate()}
              disabled={busy.create}
              style={{ ...primaryButtonStyle, opacity: busy.create ? 0.6 : 1, alignSelf: 'flex-start' }}
            >
              {busy.create ? '创建中…' : '创建并进入'}
            </button>
            {/* Git 仓库是可选的：折叠起来，避免把普通建房流程拉长（§5.2）。 */}
            <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <button
                onClick={() => setShowGitSection(prev => !prev)}
                style={{ ...buttonStyle, padding: '2px 8px', fontSize: '12px', alignSelf: 'flex-start' }}
              >
                {showGitSection ? '收起' : '展开'} Git 仓库（可选）
              </button>
              {showGitSection && renderRepoFields()}
            </div>
          </div>
        </div>

        {/* 进房 */}
        <div style={{ ...sectionStyle, flex: '1 1 320px' }}>
          <p style={sectionTitleStyle}>加入房间</p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              房号
              <input
                value={joinRoomId}
                onChange={e => setJoinRoomId(e.target.value)}
                placeholder="6 位数字"
                inputMode="numeric"
                style={{ ...inputStyle, width: '120px', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
              密码
              <input
                type="password"
                value={joinPassword}
                onChange={e => setJoinPassword(e.target.value)}
                style={{ ...inputStyle, width: '160px', marginTop: '4px' }}
              />
            </label>
            <button
              onClick={() => void handleJoin()}
              disabled={busy.join}
              style={{ ...primaryButtonStyle, opacity: busy.join ? 0.6 : 1 }}
            >
              {busy.join ? '加入中…' : '加入'}
            </button>
          </div>

          <p style={{ ...sectionTitleStyle, margin: '16px 0 8px' }}>可发现的房间</p>
          {listedRooms.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>暂无公开房间</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {listedRooms.map(room => {
                const joined = joinedRooms.some(item => item.roomId === room.roomId)
                return (
                  <div
                    key={room.roomId}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px', background: 'var(--dsw-alias-bg-layer-1)' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 500 }}>
                        {room.name || '(未命名)'} · {room.roomId}
                        {room.locked && <span style={{ marginLeft: '6px', color: 'var(--dsw-alias-state-warn-label)' }}>已锁定</span>}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                        {room.memberCount}/{room.maxMembers} 人
                        {/* 列表只暴露公开字段，绝不回显任何密码或哈希 */}
                        {room.locked && <span> · 需要密码</span>}
                      </div>
                    </div>
                    <button
                      onClick={() => {
                        setJoinRoomId(room.roomId)
                        void handleJoin(room.roomId, joinPassword)
                      }}
                      disabled={busy.join}
                      style={{ ...buttonStyle, flexShrink: 0 }}
                    >
                      {joined ? '重新进房' : '加入'}
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 已进入的房间 */}
      <div style={sectionStyle}>
        <p style={sectionTitleStyle}>已进入的房间</p>
        {joinedRooms.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>还没有进入任何房间。聊天必须先建房或进房。</p>
        ) : (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {joinedRooms.map(room => (
              <div
                key={room.roomId}
                style={{
                  padding: '8px 10px',
                  border: selectedRoom?.roomId === room.roomId ? '2px solid var(--dsw-alias-state-business-primary)' : '1px solid var(--dsw-alias-border-l2)',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  minWidth: '180px'
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 500 }}>
                  {room.name || '(未命名)'} · {room.roomId}
                  {room.role === 'owner' && <span style={{ marginLeft: '6px', color: 'var(--dsw-alias-state-business-primary)' }}>房主</span>}
                </div>
                <div style={{ display: 'flex', gap: '6px', marginTop: '6px' }}>
                  <button onClick={() => client.setActiveRoom(room.roomId)} style={{ ...buttonStyle, padding: '2px 8px', fontSize: '12px' }}>设为当前</button>
                  <button
                    onClick={() => {
                      setError('leave', null)
                      client.leaveRoom(room.roomId).catch(error => setError('leave', formatRoomError(error)))
                    }}
                    style={{ ...buttonStyle, padding: '2px 8px', fontSize: '12px' }}
                  >
                    退出
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {selectedRoom && (
          <p style={{ margin: '8px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
            当前房间：{selectedRoom.name || '(未命名)'} · {selectedRoom.roomId}（{selectedRoom.role === 'owner' ? '房主' : '成员'}）
          </p>
        )}
      </div>

      {/* 成员与房主操作 */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <p style={sectionTitleStyle}>成员</p>
          {activeRoomId && (
            <button onClick={() => void refreshMembers(activeRoomId)} style={{ ...buttonStyle, padding: '2px 8px', fontSize: '12px' }}>刷新成员</button>
          )}
        </div>
        {!activeRoomId ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>请先选择一个已进入的房间</p>
        ) : selectedMembers.length === 0 ? (
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>暂无成员数据</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {selectedMembers.map(member => (
              <div key={member.deviceId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 0' }}>
                <span style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: member.online ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-caption)' }} />
                  {member.deviceName}
                  <RoleTag role={member.role} />
                  <span style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px' }}>
                    {member.online ? '在线' : '离线'} · {member.sessionCount} 个会话 · {formatTime(member.joinedAt)}
                  </span>
                </span>
                {/* 踢人只能由房主发起；房主自己用「退出房间」而不是踢自己 */}
                {isOwner && member.role !== 'owner' && (
                  <button
                    onClick={() => {
                      runAction(
                        'kick',
                        () => client.kickMember(activeRoomId, member.deviceId),
                        `已移出 ${member.deviceName}`
                      ).then(() => refreshMembers(activeRoomId))
                    }}
                    style={{ ...dangerButtonStyle, padding: '2px 8px', fontSize: '12px' }}
                  >
                    移出房间
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {activeRoomId && !isOwner && (
          <p style={{ margin: '12px 0 0', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>房主操作仅对房主可见。</p>
        )}

        {activeRoomId && isOwner && (
          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid var(--dsw-alias-border-l1)', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>房主操作</p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                新密码
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  style={{ ...inputStyle, width: '140px', marginTop: '4px' }}
                />
              </label>
              <label style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                确认新密码
                <input
                  type="password"
                  value={confirmNewPassword}
                  onChange={e => setConfirmNewPassword(e.target.value)}
                  style={{ ...inputStyle, width: '140px', marginTop: '4px' }}
                />
              </label>
              <button onClick={() => void handleChangePassword()} disabled={busy.password} style={buttonStyle}>改密码</button>
            </div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                onClick={() => void runAction(
                  'lock',
                  () => client.setRoomLocked(activeRoomId, !(selectedRoomInfo?.locked ?? false)),
                  (selectedRoomInfo?.locked ?? false) ? '房间已解锁' : '房间已锁定'
                )}
                disabled={busy.lock}
                style={buttonStyle}
              >
                {selectedRoomInfo?.locked ? '解锁房间' : '锁定房间'}
              </button>
              <button
                onClick={() => void runAction('close', () => client.closeRoom(activeRoomId), '房间已关闭')}
                disabled={busy.close}
                style={dangerButtonStyle}
              >
                关闭房间
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 仓库与工作区（§5.2）：房主配仓库、成员绑本机工作区；状态由推送与请求共同刷新。 */}
      {activeRoomId && (
        <div style={sectionStyle}>
          <p style={sectionTitleStyle}>仓库与工作区</p>
          {!activeGitStatus && (
            <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>正在读取仓库状态…</p>
          )}

          {activeGitStatus && !activeGitStatus.configured && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <p style={{ margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-secondary)' }}>
                房主尚未设置仓库。设置后成员才能绑定本机工作区并自动同步。
              </p>
              {isOwner && (
                <>
                  {renderRepoFields()}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button onClick={() => void handleSaveRepo()} disabled={busy.git} style={primaryButtonStyle}>保存仓库</button>
                    <button onClick={() => void handleClearRepo()} disabled={busy.git} style={buttonStyle}>清除仓库</button>
                  </div>
                </>
              )}
            </div>
          )}

          {activeGitStatus && activeGitStatus.configured && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', fontSize: '13px' }}>
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>远端</span>
                <span style={{ wordBreak: 'break-all' }}>{activeGitStatus.remoteUrl ?? '（未知）'}</span>
                <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>分支</span>
                <span>{activeGitStatus.branch ?? 'main'}</span>
                <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                  <input
                    type="checkbox"
                    checked={activeGitStatus.autoPush}
                    disabled={!isOwner || (activeGitStatus.authConfigured && repoToken.trim() === '')}
                    onChange={e => void handleSetAutoPush(e.target.checked)}
                  />
                  自动推送
                </label>
              </div>
              {/* 令牌不回显，直接切换会把已保存的令牌覆盖掉；宁可禁用并说明，也不静默丢凭据。 */}
              {isOwner && activeGitStatus.authConfigured && repoToken.trim() === '' && (
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' }}>
                  房间已配置访问令牌（不回显）。切换自动推送会覆盖仓库配置，请先用「修改仓库」重新填写令牌。
                </p>
              )}

              {isOwner && !editingRepo && (
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    onClick={() => {
                      setRepoUrl(activeGitStatus.remoteUrl ?? '')
                      setRepoBranch(activeGitStatus.branch ?? 'main')
                      setRepoAutoPush(activeGitStatus.autoPush)
                      setEditingRepo(true)
                    }}
                    style={buttonStyle}
                  >
                    修改仓库
                  </button>
                  <button onClick={() => void handleClearRepo()} disabled={busy.git} style={dangerButtonStyle}>清除仓库</button>
                </div>
              )}
              {isOwner && editingRepo && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '6px' }}>
                  {renderRepoFields()}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    <button onClick={() => void handleSaveRepo()} disabled={busy.git} style={primaryButtonStyle}>保存仓库</button>
                    <button onClick={() => setEditingRepo(false)} style={buttonStyle}>取消</button>
                  </div>
                </div>
              )}

              <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <p style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>我的工作区</p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ ...fieldLabelStyle, flex: '1 1 240px' }}>
                    工作区路径
                    <input
                      value={workspacePath}
                      onChange={e => setWorkspacePath(e.target.value)}
                      list="workspace-candidates"
                      placeholder="本机目录绝对路径"
                      style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
                    />
                  </label>
                  <datalist id="workspace-candidates">
                    {workspaceCandidates.map(path => <option key={path} value={path} />)}
                  </datalist>
                  <button onClick={() => void handleBindWorkspace()} disabled={busy.workspace} style={primaryButtonStyle}>绑定</button>
                  <button onClick={() => void handleUnbindWorkspace()} disabled={busy.workspace} style={buttonStyle}>解绑</button>
                  <button onClick={() => void handleSyncNow()} disabled={busy.sync} style={buttonStyle}>立即同步</button>
                </div>
              </div>

              <div style={{ borderTop: '1px solid var(--dsw-alias-border-l1)', paddingTop: '8px' }}>
                <p style={{ margin: '0 0 6px', fontSize: '13px', fontWeight: 600 }}>成员工作区状态</p>
                {activeGitStatus.bindings.length === 0 ? (
                  <p style={{ margin: 0, fontSize: '13px', color: 'var(--dsw-alias-label-tertiary)' }}>还没有成员绑定工作区</p>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    {activeGitStatus.bindings.map(binding => (
                      <div key={binding.deviceId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 0', fontSize: '13px' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
                          <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: binding.bound ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-caption)', flexShrink: 0 }} />
                          <span>{binding.deviceName}</span>
                          <span style={{ fontSize: '12px', color: binding.bound ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-tertiary)' }}>
                            {binding.bound ? '已绑定' : '未绑定'}
                          </span>
                          {binding.workspacePath && (
                            <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', wordBreak: 'break-all' }}>{binding.workspacePath}</span>
                          )}
                        </span>
                        <span style={{ fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', textAlign: 'right' }}>
                          {binding.lastSync
                            ? `${formatTime(binding.lastSync.at)} · ${binding.lastSync.ok ? (binding.lastSync.pushed ? '已推送' : '已提交未推送') : '同步失败'} · ${binding.lastSync.committed} 个文件`
                            : '尚未同步'}
                          {binding.lastSync?.error && (
                            <span style={{ color: 'var(--dsw-alias-state-error-primary)', marginLeft: '6px' }}>{binding.lastSync.error}</span>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 预览：让 UI 也能看到房内的历史消息（当前房间） */}
      {activeRoomId && (
        <div style={sectionStyle}>
          <p style={sectionTitleStyle}>当前房间最近消息</p>
          <RoomMessagePreview client={client} roomId={activeRoomId} />
        </div>
      )}
    </div>
  )
}

const RoleTag: React.FC<{ role: RoomRole }> = ({ role }) => (
  <span style={{ padding: '1px 6px', borderRadius: '8px', fontSize: '11px', background: role === 'owner' ? 'var(--dsw-alias-state-business-tertiary)' : 'var(--dsw-alias-bg-layer-2)', color: role === 'owner' ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-secondary)' }}>
    {role === 'owner' ? '房主' : '成员'}
  </span>
)

/** 房间消息预览：只读，发消息仍然由聊天页签负责（那里才有输入框与 typing 节流）。 */
const RoomMessagePreview: React.FC<{ client: CrossTransferClient; roomId: string }> = ({ client, roomId }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([])

  useEffect(() => {
    const handleHistory = (history: ChatMessage[]) => setMessages(history)
    const handleMessage = (message: ChatMessage) => {
      if (message.roomId !== roomId) return
      setMessages(prev => [...prev, message])
    }
    client.on('chatHistory', handleHistory)
    client.on('chatMessage', handleMessage)
    client.requestChatHistory(roomId)
    return () => {
      client.off('chatHistory', handleHistory)
      client.off('chatMessage', handleMessage)
    }
  }, [client, roomId])

  if (messages.length === 0) {
    return <p style={{ margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>暂无消息</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflow: 'auto' }}>
      {messages.slice(-20).map(message => (
        <div key={message.messageId} style={{ fontSize: '13px' }}>
          <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>{formatTime(message.timestamp)} {message.senderDeviceName}：</span>
          <span>{message.content}</span>
        </div>
      ))}
    </div>
  )
}
