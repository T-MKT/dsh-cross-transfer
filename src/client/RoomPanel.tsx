import React, { useState, useEffect, useCallback } from 'react'
import { CrossTransferClient, RoomRequestError, type ActiveRoom, type ChatMessage } from './CrossTransferClient.js'
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
  border: '1px solid #ddd',
  borderRadius: '4px',
  background: '#fff',
  cursor: 'pointer',
  fontSize: '13px'
}

const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#007bff',
  color: '#fff',
  border: 'none'
}

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#dc3545',
  color: '#fff',
  border: 'none'
}

const inputStyle: React.CSSProperties = {
  padding: '6px 10px',
  border: '1px solid #ddd',
  borderRadius: '6px',
  fontSize: '13px',
  fontFamily: 'inherit'
}

const sectionStyle: React.CSSProperties = {
  padding: '12px',
  border: '1px solid #eee',
  borderRadius: '8px',
  background: '#fafafa'
}

const sectionTitleStyle: React.CSSProperties = { margin: '0 0 8px', fontSize: '14px', fontWeight: 600, color: '#333' }

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

  // 进房表单
  const [joinRoomId, setJoinRoomId] = useState('')
  const [joinPassword, setJoinPassword] = useState('')

  // 房间数据
  const [listedRooms, setListedRooms] = useState<RoomInfo[]>([])
  const [joinedRooms, setJoinedRooms] = useState<JoinedView[]>([])
  const [membersByRoom, setMembersByRoom] = useState<Record<string, RoomMember[]>>({})
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)

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
    markBusy('create', true)
    try {
      const room = await client.createRoom({
        roomId: roomId || undefined,
        name: createName.trim() || undefined,
        password: createPassword,
        maxMembers: createMaxMembers.trim() === '' ? undefined : maxMembers,
        discoverable: createDiscoverable
      })
      // 建完立刻把明文从组件状态里丢掉，页面不再持有密码。
      setCreatePassword('')
      setCreateConfirm('')
      setCreateRoomId('')
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

  const runOwnerAction = async (key: string, action: () => Promise<void>, successText: string) => {
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
    await runOwnerAction(
      'password',
      () => client.changeRoomPassword(activeRoomId, newPassword),
      '密码已更新（已在房内的成员不受影响，仅影响之后的新加入者）'
    )
    setNewPassword('')
    setConfirmNewPassword('')
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflow: 'auto', background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ margin: 0 }}>Rooms</h3>
        <button onClick={() => void refreshRooms()} style={buttonStyle}>刷新房间列表</button>
      </div>

      {/* 错误区：code 已翻成人话，限流额外显示倒计时 */}
      {retryUntil !== null && (
        <div style={{ padding: '8px 12px', background: '#fff3cd', color: '#856404', border: '1px solid #ffeeba', borderRadius: '6px', fontSize: '13px' }}>
          请求被限流，<Countdown until={retryUntil} /> 秒后可以重试。
        </div>
      )}
      {errorList.length > 0 && (
        <div style={{ padding: '8px 12px', background: '#f8d7da', color: '#721c24', border: '1px solid #f5c6cb', borderRadius: '6px', fontSize: '13px' }}>
          {errorList.map(([key, message]) => <div key={key}>{message}</div>)}
        </div>
      )}
      {Object.entries(notices).map(([key, message]) => (
        <div key={key} style={{ padding: '8px 12px', background: '#d4edda', color: '#155724', border: '1px solid #c3e6cb', borderRadius: '6px', fontSize: '13px' }}>
          {message}
        </div>
      ))}

      <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* 建房 */}
        <div style={{ ...sectionStyle, flex: '1 1 320px' }}>
          <p style={sectionTitleStyle}>创建房间</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '12px', color: '#666' }}>
              房号（留空自动生成）
              <input
                value={createRoomId}
                onChange={e => setCreateRoomId(e.target.value)}
                placeholder="4~12 位数字"
                inputMode="numeric"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#666' }}>
              房间名
              <input
                value={createName}
                onChange={e => setCreateName(e.target.value)}
                placeholder="可选"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#666' }}>
              密码
              <input
                type="password"
                value={createPassword}
                onChange={e => setCreatePassword(e.target.value)}
                placeholder="至少 6 位"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#666' }}>
              确认密码
              <input
                type="password"
                value={createConfirm}
                onChange={e => setCreateConfirm(e.target.value)}
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#666' }}>
              人数上限
              <input
                value={createMaxMembers}
                onChange={e => setCreateMaxMembers(e.target.value)}
                inputMode="numeric"
                style={{ ...inputStyle, width: '100%', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '13px', color: '#333', display: 'flex', alignItems: 'center', gap: '6px' }}>
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
          </div>
        </div>

        {/* 进房 */}
        <div style={{ ...sectionStyle, flex: '1 1 320px' }}>
          <p style={sectionTitleStyle}>加入房间</p>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '12px', color: '#666' }}>
              房号
              <input
                value={joinRoomId}
                onChange={e => setJoinRoomId(e.target.value)}
                placeholder="6 位数字"
                inputMode="numeric"
                style={{ ...inputStyle, width: '120px', marginTop: '4px' }}
              />
            </label>
            <label style={{ fontSize: '12px', color: '#666' }}>
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
            <p style={{ margin: 0, color: '#999', fontSize: '13px' }}>暂无公开房间</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              {listedRooms.map(room => {
                const joined = joinedRooms.some(item => item.roomId === room.roomId)
                return (
                  <div
                    key={room.roomId}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '6px 8px', border: '1px solid #eee', borderRadius: '6px', background: '#fff' }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: '13px', fontWeight: 500 }}>
                        {room.name || '(未命名)'} · {room.roomId}
                        {room.locked && <span style={{ marginLeft: '6px', color: '#856404' }}>已锁定</span>}
                      </div>
                      <div style={{ fontSize: '12px', color: '#666' }}>
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
          <p style={{ margin: 0, color: '#999', fontSize: '13px' }}>还没有进入任何房间。聊天必须先建房或进房。</p>
        ) : (
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            {joinedRooms.map(room => (
              <div
                key={room.roomId}
                style={{
                  padding: '8px 10px',
                  border: selectedRoom?.roomId === room.roomId ? '2px solid #007bff' : '1px solid #ddd',
                  borderRadius: '8px',
                  background: '#fff',
                  minWidth: '180px'
                }}
              >
                <div style={{ fontSize: '13px', fontWeight: 500 }}>
                  {room.name || '(未命名)'} · {room.roomId}
                  {room.role === 'owner' && <span style={{ marginLeft: '6px', color: '#007bff' }}>房主</span>}
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
          <p style={{ margin: '8px 0 0', fontSize: '12px', color: '#666' }}>
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
          <p style={{ margin: 0, color: '#999', fontSize: '13px' }}>请先选择一个已进入的房间</p>
        ) : selectedMembers.length === 0 ? (
          <p style={{ margin: 0, color: '#999', fontSize: '13px' }}>暂无成员数据</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {selectedMembers.map(member => (
              <div key={member.deviceId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', padding: '4px 0' }}>
                <span style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: member.online ? '#28a745' : '#ccc' }} />
                  {member.deviceName}
                  <RoleTag role={member.role} />
                  <span style={{ color: '#999', fontSize: '12px' }}>
                    {member.online ? '在线' : '离线'} · {member.sessionCount} 个会话 · {formatTime(member.joinedAt)}
                  </span>
                </span>
                {/* 踢人只能由房主发起；房主自己用「退出房间」而不是踢自己 */}
                {isOwner && member.role !== 'owner' && (
                  <button
                    onClick={() => {
                      runOwnerAction(
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
          <p style={{ margin: '12px 0 0', fontSize: '12px', color: '#999' }}>房主操作仅对房主可见。</p>
        )}

        {activeRoomId && isOwner && (
          <div style={{ marginTop: '12px', paddingTop: '12px', borderTop: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p style={{ margin: 0, fontSize: '13px', fontWeight: 600 }}>房主操作</p>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '12px', color: '#666' }}>
                新密码
                <input
                  type="password"
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  style={{ ...inputStyle, width: '140px', marginTop: '4px' }}
                />
              </label>
              <label style={{ fontSize: '12px', color: '#666' }}>
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
                onClick={() => void runOwnerAction(
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
                onClick={() => void runOwnerAction('close', () => client.closeRoom(activeRoomId), '房间已关闭')}
                disabled={busy.close}
                style={dangerButtonStyle}
              >
                关闭房间
              </button>
            </div>
          </div>
        )}
      </div>

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
  <span style={{ padding: '1px 6px', borderRadius: '8px', fontSize: '11px', background: role === 'owner' ? '#cce5ff' : '#f0f0f0', color: role === 'owner' ? '#004085' : '#666' }}>
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
    return <p style={{ margin: 0, color: '#999', fontSize: '13px' }}>暂无消息</p>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflow: 'auto' }}>
      {messages.slice(-20).map(message => (
        <div key={message.messageId} style={{ fontSize: '13px' }}>
          <span style={{ color: '#666' }}>{formatTime(message.timestamp)} {message.senderDeviceName}：</span>
          <span>{message.content}</span>
        </div>
      ))}
    </div>
  )
}
