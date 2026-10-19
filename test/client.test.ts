import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http'
import type { AddressInfo } from 'net'
import { createHash, randomBytes } from 'crypto'
import { CrossTransferClient, RoomRequestError } from '../src/client/CrossTransferClient.js'
import type { RoomInfo, RoomMember } from '../src/rooms.js'
import { WSServer } from '../src/ws-server.js'

const WS_PATH = '/api/cross-transfer'
const TOKEN_SECRET = 'test-token-secret'

function createClient(deviceName = 'TestDevice'): CrossTransferClient {
  return new CrossTransferClient(new Context(), { deviceName })
}

function localStore(): Map<string, string> {
  return (globalThis.localStorage as any).store
}

function makeOfferPayload(overrides: Record<string, unknown> = {}) {
  return {
    fileId: 'file-1',
    fileName: 'note.txt',
    fileSize: 100,
    mimeType: 'text/plain',
    checksum: 'abc123',
    chunkCount: 4,
    senderDeviceId: 'peer-device',
    senderDeviceName: 'Peer Device',
    ...overrides,
  }
}

function makeChatMessage(): Record<string, unknown> {
  return {
    messageId: 'msg-1',
    roomId: 'default',
    senderDeviceId: 'peer-device',
    senderDeviceName: 'Peer Device',
    senderSessionId: 'sess-1',
    content: 'hello world',
    type: 'text',
    timestamp: 1700000000000,
  }
}

function makeRoomInfo(roomId = '123456'): RoomInfo {
  return {
    roomId,
    name: 'Demo Room',
    ownerDeviceId: 'aaaa…bbbb',
    ownerOnline: true,
    createdAt: 1699999999000,
    lastActivityAt: 1700000000000,
    memberCount: 1,
    maxMembers: 16,
    locked: false,
    discoverable: true,
  }
}

function makeMember(): RoomMember {
  return {
    deviceId: 'dev-1',
    deviceName: 'Test Device',
    role: 'member',
    joinedAt: 1699999999500,
    sessionCount: 1,
    online: true,
  }
}

describe('CrossTransferClient', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', {
      store: new Map<string, string>(),
      getItem(k: string) {
        return this.store.get(k) ?? null
      },
      setItem(k: string, v: string) {
        this.store.set(k, String(v))
      },
      removeItem(k: string) {
        this.store.delete(k)
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ---------- 构造与设备标识 ----------

  describe('构造与设备标识', () => {
    it('登记前 getDeviceId() 为空：deviceId 由服务端凭 secret 派生，客户端不再自报', () => {
      const client = createClient()
      expect(client.getDeviceId()).toBe('')
      expect(client.getToken()).toBe('')
    })

    it('getDeviceName() 返回配置的 deviceName', () => {
      const client = createClient('TestDevice')
      expect(client.getDeviceName()).toBe('TestDevice')
    })

    it('localStorage 里只有旧的 deviceId 键时被丢弃：旧值可被抄写，不能当身份', () => {
      localStore().set('dsh-cross-transfer-device-id', '0123456789abcdef')
      const client = createClient()
      expect(client.getDeviceId()).toBe('')
      expect(localStore().has('dsh-cross-transfer-device-id')).toBe(false)
    })

    it('登记后 deviceId 为 16 位十六进制，secret 写入 localStorage 且新实例复用', async () => {
      // node 环境的 fetch 拒绝相对 URL（浏览器里同源相对 URL 合法），这里 stub 掉，
      // 并按服务端同一公式（sha256('xfer-device:'+secret) 前 16 位）派生 deviceId。
      vi.stubGlobal('fetch', vi.fn(async () => {
        const deviceSecret = randomBytes(32).toString('hex')
        const deviceId = createHash('sha256').update(`xfer-device:${deviceSecret}`).digest('hex').slice(0, 16)
        return {
          ok: true,
          status: 200,
          json: async () => ({ deviceId, deviceSecret, deviceName: 'TestDevice', token: `token-${deviceId}` }),
        }
      }))

      const first = createClient()
      await (first as any).registerDevice(undefined)
      expect(first.getDeviceId()).toMatch(/^[0-9a-f]{16}$/)

      const secret = localStore().get('dsh-cross-transfer-device-secret')
      expect(secret).toMatch(/^[0-9a-f]{64}$/)

      const second = createClient()
      expect((second as any).deviceSecret).toBe(secret)
      expect(second.getDeviceId()).toBe('')
    })

    it('setDeviceName() 修改设备名', () => {
      const client = createClient('TestDevice')
      client.setDeviceName('Renamed-Device')
      expect(client.getDeviceName()).toBe('Renamed-Device')
    })
  })

  // ---------- 连接状态 ----------

  describe('连接状态', () => {
    it('未连接时 isConnected() 返回 false', () => {
      const client = createClient()
      expect(client.isConnected()).toBe(false)
    })

    it('未连接时 getSession() 返回 null', () => {
      const client = createClient()
      expect(client.getSession()).toBeNull()
    })

    it('未连接时私有 send() 返回 false', () => {
      const client = createClient()
      const result = (client as any).send({ type: 'ping', payload: {} })
      expect(result).toBe(false)
    })

    it('disconnect() 清理连接状态并关闭底层 socket', () => {
      const client = createClient()
      const fakeWs = { readyState: 1, close: vi.fn() }
      ;(client as any).ws = fakeWs
      ;(client as any).session = {
        id: 'sess-1',
        deviceId: client.getDeviceId(),
        deviceName: 'TestDevice',
        connectedAt: Date.now(),
      }
      expect(client.isConnected()).toBe(true)

      client.disconnect()

      expect(fakeWs.close).toHaveBeenCalledWith(1000, 'Client disconnect')
      expect(client.isConnected()).toBe(false)
      expect(client.getSession()).toBeNull()
      expect((client as any).ws).toBeNull()
    })
  })

  // ---------- handleMessage 消息路由 ----------

  describe('handleMessage 消息路由', () => {
    it('peer-connected 触发 peerConnected 事件并透传 PeerDevice', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('peerConnected', listener)

      const peer = {
        deviceId: 'peer-device',
        deviceName: 'Peer Device',
        sessionCount: 1,
        capabilities: ['chat'],
      }
      ;(client as any).handleMessage({ type: 'peer-connected', payload: peer })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(peer)
    })

    it('peer-disconnected 触发 peerDisconnected 事件', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('peerDisconnected', listener)

      const peer = { deviceId: 'peer-device', deviceName: 'Peer Device', sessionCount: 0, capabilities: [] }
      ;(client as any).handleMessage({ type: 'peer-disconnected', payload: peer })

      expect(listener).toHaveBeenCalledWith(peer)
    })

    it('chat-message 触发 chatMessage 事件', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('chatMessage', listener)

      const message = makeChatMessage()
      ;(client as any).handleMessage({ type: 'chat-message', payload: message })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(message)
    })

    it('chat-history 触发 chatHistory 事件并携带消息数组', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('chatHistory', listener)

      const messages = [makeChatMessage(), { ...makeChatMessage(), messageId: 'msg-2', content: 'second' }]
      ;(client as any).handleMessage({ type: 'chat-history', payload: { messages } })

      expect(listener).toHaveBeenCalledWith(messages)
    })

    it('user-joined 触发 chatUserJoined 事件并展开为三个参数', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('chatUserJoined', listener)

      const payload = { roomId: 'room-1', deviceId: 'peer-device', deviceName: 'Peer Device' }
      ;(client as any).handleMessage({ type: 'user-joined', payload })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('room-1', 'peer-device', 'Peer Device')
    })

    it('user-left 触发 chatUserLeft 事件并展开为两个参数', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('chatUserLeft', listener)

      const payload = { roomId: 'room-1', deviceId: 'peer-device' }
      ;(client as any).handleMessage({ type: 'user-left', payload })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('room-1', 'peer-device')
    })

    it('typing 触发 chatTyping 事件并展开为四个参数', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('chatTyping', listener)

      ;(client as any).handleMessage({
        type: 'typing',
        payload: { roomId: 'room-1', deviceId: 'peer-device', deviceName: 'Peer Device', isTyping: true },
      })

      expect(listener).toHaveBeenCalledWith('room-1', 'peer-device', 'Peer Device', true)
    })

    it('file-offer 触发 fileOffer 事件并记录 status=pending 的传输', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('fileOffer', listener)

      ;(client as any).handleMessage({
        type: 'file-offer',
        payload: makeOfferPayload(),
        fromDeviceId: 'peer-device',
      })

      expect(listener).toHaveBeenCalledTimes(1)
      const [info, fromDeviceId] = listener.mock.calls[0]
      expect(fromDeviceId).toBe('peer-device')
      expect(info).toEqual(
        expect.objectContaining({
          fileId: 'file-1',
          fileName: 'note.txt',
          chunkCount: 4,
          status: 'pending',
          progress: 0,
          receivedChunks: 0,
        }),
      )

      const stored = (client as any).fileTransfers.get('file-1')
      expect(stored).toBeDefined()
      expect(stored.status).toBe('pending')
      expect(stored.receivedChunks).toBe(0)
    })

    it('file-chunk 触发 fileProgress 事件并正确计算进度百分比', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('fileProgress', listener)

      ;(client as any).handleMessage({ type: 'file-offer', payload: makeOfferPayload() })
      ;(client as any).handleMessage({
        type: 'file-chunk',
        payload: { fileId: 'file-1', chunkIndex: 1, totalChunks: 4 },
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('file-1', { received: 2, total: 4, percentage: 50 })

      const info = (client as any).fileTransfers.get('file-1')
      expect(info.progress).toBe(50)
      expect(info.receivedChunks).toBe(2)
      expect(info.status).toBe('receiving')

      // 收齐最后一块 -> 100%
      ;(client as any).handleMessage({
        type: 'file-chunk',
        payload: { fileId: 'file-1', chunkIndex: 3, totalChunks: 4 },
      })
      expect(listener).toHaveBeenLastCalledWith('file-1', { received: 4, total: 4, percentage: 100 })
    })

    it('file-complete 触发 fileComplete 事件并携带 Uint8Array 数据', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('fileComplete', listener)

      ;(client as any).handleMessage({ type: 'file-offer', payload: makeOfferPayload() })
      ;(client as any).handleMessage({
        type: 'file-complete',
        payload: { fileId: 'file-1', data: [72, 101, 108, 108, 111] },
      })

      expect(listener).toHaveBeenCalledTimes(1)
      const [fileId, data] = listener.mock.calls[0]
      expect(fileId).toBe('file-1')
      expect(data).toBeInstanceOf(Uint8Array)
      expect(Array.from(data as Uint8Array)).toEqual([72, 101, 108, 108, 111])

      // 完成后从 fileTransfers 中移除
      expect((client as any).fileTransfers.has('file-1')).toBe(false)
    })

    it('device-list 触发 deviceList 事件并携带设备数组', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('deviceList', listener)

      const devices = [
        { deviceId: 'a'.repeat(16), deviceName: 'Device A', sessionCount: 1, capabilities: [] },
        { deviceId: 'b'.repeat(16), deviceName: 'Device B', sessionCount: 2, capabilities: ['chat'] },
      ]
      ;(client as any).handleMessage({ type: 'device-list', payload: { devices } })

      expect(listener).toHaveBeenCalledWith(devices)
    })

    it('sync-progress 触发 syncProgress 事件并展开为 repoId 与 progress', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('syncProgress', listener)

      const payload = { repoId: 'repo-1', progress: { phase: 'fetch', loaded: 1, total: 4 } }
      ;(client as any).handleMessage({ type: 'sync-progress', payload })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('repo-1', { phase: 'fetch', loaded: 1, total: 4 })
    })

    it('sync-complete 触发 syncComplete 事件', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('syncComplete', listener)

      const result = {
        success: true,
        operation: 'pull',
        repoId: 'repo-1',
        filesChanged: 3,
        commitsAhead: 0,
        commitsBehind: 0,
      }
      ;(client as any).handleMessage({ type: 'sync-complete', payload: result })

      expect(listener).toHaveBeenCalledWith(result)
    })

    it('sync-error 触发 syncError 事件并展开为三个参数', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('syncError', listener)

      ;(client as any).handleMessage({
        type: 'sync-error',
        payload: { repoId: 'repo-1', error: 'merge conflict', operation: 'pull' },
      })

      expect(listener).toHaveBeenCalledWith('repo-1', 'merge conflict', 'pull')
    })

    it('sync-conflict 触发 syncConflict 事件并展开为 repoId 与冲突列表', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('syncConflict', listener)

      const payload = { repoId: 'repo-1', conflicts: ['src/a.ts', 'src/b.ts'] }
      ;(client as any).handleMessage({ type: 'sync-conflict', payload })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('repo-1', ['src/a.ts', 'src/b.ts'])
    })

    it('repo-list 触发 repoList 事件并携带仓库数组', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('repoList', listener)

      const repos = [
        {
          repoId: 'repo-1',
          name: 'demo',
          localPath: '/tmp/demo',
          remoteUrl: 'https://example.com/demo.git',
          branch: 'main',
        },
      ]
      ;(client as any).handleMessage({ type: 'repo-list', payload: { repos } })

      expect(listener).toHaveBeenCalledWith(repos)
    })

    it('error 触发 error 事件并包装为 Error 对象', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('error', listener)

      ;(client as any).handleMessage({ type: 'error', payload: 'server exploded' })

      expect(listener).toHaveBeenCalledTimes(1)
      const error = listener.mock.calls[0][0]
      expect(error).toBeInstanceOf(Error)
      expect(error.message).toBe('server exploded')
    })
  })

  // ---------- 请求、取消与断开 ----------

  describe('请求、取消与断开', () => {
    it('带 messageId 的回复消息会 resolve 对应 pendingRequest', async () => {
      const client = createClient()
      const pending = (client as any).request({ type: 'ping', payload: {} })

      const messageId = [...(client as any).pendingRequests.keys()][0]
      expect(messageId).toMatch(/^req_/)

      ;(client as any).handleMessage({ type: 'pong', payload: { ts: 123 }, messageId })

      await expect(pending).resolves.toEqual({ ts: 123 })
      expect((client as any).pendingRequests.size).toBe(0)
    })

    it('带 messageId 的 error 回复会 reject 对应 pendingRequest（字符串 payload 行为不变）', async () => {
      const client = createClient()
      const pending = (client as any).request({ type: 'git-sync', payload: {} })

      const messageId = [...(client as any).pendingRequests.keys()][0]
      ;(client as any).handleMessage({ type: 'error', payload: 'nope', messageId })

      await expect(pending).rejects.toThrow('nope')
      expect((client as any).pendingRequests.size).toBe(0)
    })

    it('error payload 是对象时 reject 出来的 Error 带 code 与 retryAfterMs', async () => {
      const client = createClient()
      const pending = (client as any).request({ type: 'room-join', payload: { roomId: '1', password: 'x' } })

      const messageId = [...(client as any).pendingRequests.keys()][0]
      ;(client as any).handleMessage({
        type: 'error',
        messageId,
        payload: { code: 'too-many-attempts', message: 'Too many attempts', retryAfterMs: 120000 },
      })

      const error = await pending.catch((e: unknown) => e)
      expect(error).toBeInstanceOf(RoomRequestError)
      expect((error as RoomRequestError).code).toBe('too-many-attempts')
      expect((error as RoomRequestError).message).toBe('Too many attempts')
      expect((error as RoomRequestError).retryAfterMs).toBe(120000)
    })

    it('无 messageId 的对象 error payload 走 error 事件并带出 code', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('error', listener)

      ;(client as any).handleMessage({ type: 'error', payload: { code: 'room-locked', message: 'Room is locked' } })

      const error = listener.mock.calls[0][0]
      expect(error).toBeInstanceOf(RoomRequestError)
      expect((error as any).code).toBe('room-locked')
    })

    it('room-exists 的 error payload 对象会被 reject 成带 code 的 RoomRequestError', async () => {
      const client = createClient()
      const pending = (client as any).request({ type: 'room-create', payload: { password: 'x' } })

      const messageId = [...(client as any).pendingRequests.keys()][0]
      ;(client as any).handleMessage({ type: 'error', messageId, payload: { code: 'room-exists', message: 'Room already exists' } })

      const error = await pending.catch((e: unknown) => e)
      expect((error as RoomRequestError).code).toBe('room-exists')
    })

    it('request() 超时后 reject Request timeout', async () => {
      const client = createClient()
      const sendSpy = vi.spyOn(client as any, 'send').mockReturnValue(false)

      await expect((client as any).request({ type: 'slow', payload: {} }, 30)).rejects.toThrow(
        'Request timeout',
      )

      expect(sendSpy).toHaveBeenCalledTimes(1)
      expect((client as any).pendingRequests.size).toBe(0)
      sendSpy.mockRestore()
    })

    it('cancelFile() 将传输标记为 cancelled 并从 fileTransfers 删除', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('fileOffer', listener)

      ;(client as any).handleMessage({ type: 'file-offer', payload: makeOfferPayload() })
      const info = listener.mock.calls[0][0]
      expect((client as any).fileTransfers.has('file-1')).toBe(true)

      client.cancelFile('file-1')

      expect(info.status).toBe('cancelled')
      expect((client as any).fileTransfers.has('file-1')).toBe(false)

      // 取消不存在的 fileId 不抛错
      expect(() => client.cancelFile('missing-file')).not.toThrow()
    })
  })

  // ---------- 房间 API 的消息体 ----------

  describe('房间 API 的消息体', () => {
    function captureSends(client: CrossTransferClient): Array<Record<string, any>> {
      const sent: Array<Record<string, any>> = []
      // request() 依赖服务端回显 messageId，这里直接捕获帧并手工应答。
      vi.spyOn(client as any, 'send').mockImplementation((message: Record<string, any>) => {
        sent.push(message)
        queueMicrotask(() => {
          ;(client as any).handleMessage({
            type: (client as any).replyTypeFor(message.type),
            messageId: message.messageId,
            payload: (client as any).replyPayloadFor(message),
          })
        })
        return true
      })
      return sent
    }

    it('createRoom() 发送 room-create，payload 只带契约字段', async () => {
      const client = createClient()
      const sent = captureSends(client)

      const room = await client.createRoom({ roomId: '123456', name: 'Demo', password: 'secret-1', maxMembers: 4, discoverable: false })

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('room-create')
      expect(sent[0].messageId).toMatch(/^req_/)
      expect(sent[0].payload).toEqual({
        roomId: '123456',
        name: 'Demo',
        password: 'secret-1',
        maxMembers: 4,
        discoverable: false,
      })
      expect(room).toEqual({ roomId: '123456', name: 'Demo', role: 'owner', ticket: 'ticket-123456', expiresAt: 1700000000000 })
      // 密码留在内存里供重连重进用，但不落 localStorage。
      expect(client.getRoomPassword('123456')).toBe('secret-1')
      expect(Array.from(localStore().values())).not.toContain('secret-1')
    })

    it('joinRoom() 发送 room-join 且带密码；enterRoom() 不带密码', async () => {
      const client = createClient()
      const sent = captureSends(client)

      const room = await client.joinRoom('123456', 'secret-1')
      expect(sent[0].type).toBe('room-join')
      expect(sent[0].payload).toEqual({ roomId: '123456', password: 'secret-1' })
      expect(room.roomId).toBe('123456')

      await client.enterRoom('123456')
      expect(sent[1].type).toBe('room-join')
      expect(sent[1].payload).toEqual({ roomId: '123456' })
      expect(sent[1].payload).not.toHaveProperty('password')
    })

    it('leaveRoom() / closeRoom() 各自发送 room-leave 与 room-close', async () => {
      const client = createClient()
      const sent = captureSends(client)

      await client.joinRoom('123456', 'secret-1')
      await client.leaveRoom('123456')
      expect(sent[1].type).toBe('room-leave')
      expect(sent[1].payload).toEqual({ roomId: '123456' })

      await client.closeRoom('123456')
      expect(sent[2].type).toBe('room-close')
      expect(sent[2].payload).toEqual({ roomId: '123456' })
    })

    it('踢人 / 改密 / 锁房的消息体形状正确', async () => {
      const client = createClient()
      const sent = captureSends(client)

      await client.kickMember('123456', 'real-device-id')
      expect(sent[0].type).toBe('room-kick')
      expect(sent[0].payload).toEqual({ roomId: '123456', deviceId: 'real-device-id' })

      await client.changeRoomPassword('123456', 'next-secret')
      expect(sent[1].type).toBe('room-password')
      expect(sent[1].payload).toEqual({ roomId: '123456', password: 'next-secret' })

      await client.setRoomLocked('123456', true)
      expect(sent[2].type).toBe('room-lock')
      expect(sent[2].payload).toEqual({ roomId: '123456', locked: true })
    })

    it('房间列表 / 成员列表 / 聊天消息的消息体形状正确', async () => {
      const client = createClient()
      const sent = captureSends(client)

      await client.listRooms()
      expect(sent[0].type).toBe('room-list')
      expect(sent[0].payload).toEqual({})

      await client.requestRoomMembers('123456')
      expect(sent[1].type).toBe('room-members')
      expect(sent[1].payload).toEqual({ roomId: '123456' })

      await client.sendChatMessage('123456', 'hello', 'code', { lang: 'ts' })
      expect(sent[2].type).toBe('chat-message')
      expect(sent[2].payload).toEqual({ roomId: '123456', content: 'hello', type: 'code', metadata: { lang: 'ts' } })
    })

    it('joinRoom 成功后记录房号与票据，getJoinedRooms/getActiveRoom/setActiveRoom 同步更新', async () => {
      const client = createClient()
      captureSends(client)

      await client.joinRoom('123456', 'secret-1')
      expect(client.getJoinedRooms()).toHaveLength(1)
      expect(client.getActiveRoom()?.roomId).toBe('123456')

      await client.joinRoom('654321', 'secret-2')
      expect(client.getActiveRoom()?.roomId).toBe('654321')

      const changed = vi.fn()
      client.on('activeRoomChanged', changed)
      client.setActiveRoom('123456')
      expect(client.getActiveRoom()?.roomId).toBe('123456')
      expect(changed).toHaveBeenCalledTimes(1)

      client.setActiveRoom('999999')
      expect(client.getActiveRoom()?.roomId).toBe('123456')
      expect(changed).toHaveBeenCalledTimes(1)
    })

    it('退房 / 关房 / 被踢会清掉本地房间状态与内存密码', async () => {
      const client = createClient()
      const sent = captureSends(client)

      await client.joinRoom('123456', 'secret-1')
      await client.leaveRoom('123456')
      expect(client.getJoinedRooms()).toHaveLength(0)
      expect(client.getRoomPassword('123456')).toBeNull()
      expect(client.getActiveRoom()).toBeNull()

      await client.joinRoom('123456', 'secret-1')
      ;(client as any).handleMessage({
        type: 'room-member-kicked',
        payload: { roomId: '123456', deviceId: client.getDeviceId(), kickedByDeviceId: 'owner-1' },
      })
      expect(client.getJoinedRooms()).toHaveLength(0)
      expect(client.getRoomPassword('123456')).toBeNull()

      await client.joinRoom('123456', 'secret-1')
      ;(client as any).handleMessage({ type: 'room-closed', payload: { roomId: '123456', reason: 'closed-by-owner' } })
      expect(client.getJoinedRooms()).toHaveLength(0)
      expect(client.getRoomPassword('123456')).toBeNull()

      expect(sent.length).toBeGreaterThan(0)
    })

    it('requestChatHistory / setTyping 仍按房间消息发送', () => {
      const client = createClient()
      const sent = captureSends(client)

      client.requestChatHistory('123456', 20)
      expect(sent[0].type).toBe('chat-history-request')
      expect(sent[0].payload).toEqual({ roomId: '123456', limit: 20 })

      client.setTyping('123456', true)
      expect(sent[1].type).toBe('typing')
      expect(sent[1].payload).toEqual({ roomId: '123456', isTyping: true })
    })
  })

  // ---------- 房间事件分发 ----------

  describe('房间事件分发', () => {
    function joinPayload(roomId = '123456') {
      return {
        room: makeRoomInfo(roomId),
        member: makeMember(),
        ticket: { ticket: `ticket-${roomId}`, roomId, deviceId: 'dev-1', role: 'member', issuedAt: 1699999999000, expiresAt: 1700000000000 },
      }
    }

    it('room-joined 广播（无 messageId）触发 roomJoined 与 activeRoomChanged', () => {
      const client = createClient()
      const joined = vi.fn()
      const active = vi.fn()
      client.on('roomJoined', joined)
      client.on('activeRoomChanged', active)

      ;(client as any).handleMessage({ type: 'room-joined', payload: joinPayload() })

      expect(joined).toHaveBeenCalledTimes(1)
      expect(joined.mock.calls[0][0]).toEqual({
        roomId: '123456',
        name: 'Demo Room',
        role: 'member',
        ticket: 'ticket-123456',
        expiresAt: 1700000000000,
      })
      expect(active).toHaveBeenCalledTimes(1)
      expect(client.getActiveRoom()?.roomId).toBe('123456')
      // 广播帧里没有密码，本地也不该凭空多出一个。
      expect(client.getRoomPassword('123456')).toBeNull()
    })

    it('带 messageId 的 room-joined 应答只触发一次 roomJoined（同 type 不双触发）', async () => {
      const client = createClient()
      const joined = vi.fn()
      client.on('roomJoined', joined)

      const pending = (client as any).request({ type: 'room-join', payload: { roomId: '123456', password: 'secret-1' } })
      const messageId = [...(client as any).pendingRequests.keys()][0]
      ;(client as any).handleMessage({ type: 'room-joined', messageId, payload: joinPayload() })

      await pending
      expect(joined).toHaveBeenCalledTimes(1)
      expect(client.getJoinedRooms()).toHaveLength(1)
    })

    it('room-left 触发 roomLeft 并清理本地房间', () => {
      const client = createClient()
      const left = vi.fn()
      client.on('roomLeft', left)
      ;(client as any).handleMessage({ type: 'room-joined', payload: joinPayload() })

      ;(client as any).handleMessage({ type: 'room-left', payload: { roomId: '123456', deviceId: 'dev-1', removed: true, closed: false } })

      expect(left).toHaveBeenCalledWith('123456')
      expect(client.getJoinedRooms()).toHaveLength(0)
    })

    it('room-list 触发 roomList 并携带房间数组', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('roomList', listener)

      const rooms: RoomInfo[] = [makeRoomInfo('123456'), makeRoomInfo('654321')]
      ;(client as any).handleMessage({ type: 'room-list', payload: { rooms } })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(rooms)
    })

    it('room-members 触发 roomMembers 并展开为房号与成员数组', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('roomMembers', listener)

      const members: RoomMember[] = [makeMember()]
      ;(client as any).handleMessage({ type: 'room-members', payload: { roomId: '123456', members } })

      expect(listener).toHaveBeenCalledWith('123456', members)
    })

    it('room-member-kicked 触发 roomMemberKicked 并展开三个参数', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('roomMemberKicked', listener)

      ;(client as any).handleMessage({
        type: 'room-member-kicked',
        payload: { roomId: '123456', deviceId: 'target-device', kickedByDeviceId: 'owner-device' },
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith('123456', 'target-device', 'owner-device')
    })

    it('room-closed 触发 roomClosed 并清理本地房间', () => {
      const client = createClient()
      const listener = vi.fn()
      client.on('roomClosed', listener)

      ;(client as any).handleMessage({ type: 'room-closed', payload: { roomId: '123456', reason: 'idle-timeout' } })

      expect(listener).toHaveBeenCalledWith('123456', 'idle-timeout')
    })

    it('room-locked / room-password-changed 触发对应事件', () => {
      const client = createClient()
      const locked = vi.fn()
      const changed = vi.fn()
      client.on('roomLocked', locked)
      client.on('roomPasswordChanged', changed)

      ;(client as any).handleMessage({ type: 'room-locked', payload: { roomId: '123456', locked: true } })
      ;(client as any).handleMessage({ type: 'room-password-changed', payload: { roomId: '123456' } })

      expect(locked).toHaveBeenCalledWith('123456', true)
      expect(changed).toHaveBeenCalledWith('123456')
    })

    it('房间事件全程不外传密码：事件载荷里没有 password 字段', async () => {
      const client = createClient()
      const observed: unknown[] = []
      for (const event of ['roomJoined', 'roomLeft', 'roomClosed', 'roomMembers', 'roomLocked', 'roomPasswordChanged', 'roomMemberKicked'] as const) {
        client.on(event, (...args: unknown[]) => observed.push(args))
      }
      const sent: Array<Record<string, any>> = []
      vi.spyOn(client as any, 'send').mockImplementation((message: Record<string, any>) => {
        sent.push(message)
        queueMicrotask(() => {
          ;(client as any).handleMessage({
            type: (client as any).replyTypeFor(message.type),
            messageId: message.messageId,
            payload: (client as any).replyPayloadFor(message),
          })
        })
        return true
      })

      await client.createRoom({ roomId: '123456', name: 'Demo', password: 'top-secret-1' })
      await client.changeRoomPassword('123456', 'top-secret-2')
      await client.setRoomLocked('123456', true)
      await client.requestRoomMembers('123456')
      await client.closeRoom('123456')

      // 线上帧必须有密码（那是门禁凭据），但事件与本地状态不能外泄它。
      expect(sent.some(m => m.payload?.password === 'top-secret-1')).toBe(true)
      expect(sent.some(m => m.payload?.password === 'top-secret-2')).toBe(true)
      const serialized = JSON.stringify(observed)
      expect(serialized).not.toContain('top-secret-1')
      expect(serialized).not.toContain('top-secret-2')
      expect(serialized).not.toContain('password')
      expect(Object.keys(observed[0] as unknown as object)).toHaveLength(3)
    })
  })

  // ---------- 重连后自动重新进房 ----------

  describe('重连后自动重新进房', () => {
    it('welcome 之后对已加入房间重发 room-join，并带上内存里的密码', async () => {
      const client = createClient()
      const sent: Array<Record<string, any>> = []
      vi.spyOn(client as any, 'send').mockImplementation((message: Record<string, any>) => {
        sent.push(message)
        queueMicrotask(() => {
          ;(client as any).handleMessage({
            type: (client as any).replyTypeFor(message.type),
            messageId: message.messageId,
            payload: (client as any).replyPayloadFor(message),
          })
        })
        return true
      })

      await client.joinRoom('123456', 'secret-1')
      sent.length = 0

      ;(client as any).handleMessage({
        type: 'welcome',
        payload: { sessionId: 'sess-1', deviceId: 'dev-1', deviceName: 'TestDevice' },
      })
      await new Promise(resolve => setTimeout(resolve, 5))

      expect(sent).toHaveLength(1)
      expect(sent[0].type).toBe('room-join')
      expect(sent[0].payload).toEqual({ roomId: '123456', password: 'secret-1' })
      expect(client.getJoinedRooms()).toHaveLength(1)
    })

    it('重进失败的房间只 emit error，不重复重试', async () => {
      const client = createClient()
      const errors: Error[] = []
      client.on('error', (error: Error) => errors.push(error))
      ;(client as any).roomPasswords.set('123456', 'secret-1')
      const requestSpy = vi.spyOn(client as any, 'request').mockRejectedValue(new RoomRequestError('room-not-found', 'Room not found'))

      ;(client as any).handleMessage({ type: 'welcome', payload: { sessionId: 'sess-1', deviceId: 'dev-1', deviceName: 'TestDevice' } })
      await new Promise(resolve => setTimeout(resolve, 5))

      expect(requestSpy).toHaveBeenCalledTimes(1)
      expect(errors).toHaveLength(1)
      expect((errors[0] as RoomRequestError).code).toBe('room-not-found')
    })

    it('票据过期时若内存有密码则自动重发一次 room-join', async () => {
      const client = createClient()
      const sent: Array<Record<string, any>> = []
      let failFirst = true
      vi.spyOn(client as any, 'send').mockImplementation((message: Record<string, any>) => {
        sent.push(message)
        queueMicrotask(() => {
          if (message.type === 'room-join' && failFirst) {
            failFirst = false
            ;(client as any).handleMessage({
              type: 'error',
              messageId: message.messageId,
              payload: { code: 'invalid-ticket', message: 'Ticket has expired' },
            })
            return
          }
          ;(client as any).handleMessage({
            type: (client as any).replyTypeFor(message.type),
            messageId: message.messageId,
            payload: (client as any).replyPayloadFor(message),
          })
        })
        return true
      })

      await client.joinRoom('123456', 'secret-1')
      sent.length = 0

      await client.requestRoomMembers('123456')

      expect(sent[0].type).toBe('room-members')
      expect(sent[1].type).toBe('room-join')
      expect(sent[1].payload).toEqual({ roomId: '123456', password: 'secret-1' })
      expect(client.getJoinedRooms()).toHaveLength(1)
    })

    it('票据过期且内存无密码时只 emit error，不重发 room-join', async () => {
      const client = createClient()
      const errors: Error[] = []
      client.on('error', (error: Error) => errors.push(error))
      const sent: Array<Record<string, any>> = []
      vi.spyOn(client as any, 'send').mockImplementation((message: Record<string, any>) => {
        sent.push(message)
        if (message.type === 'room-members') {
          queueMicrotask(() => {
            ;(client as any).handleMessage({
              type: 'error',
              messageId: message.messageId,
              payload: { code: 'invalid-ticket', message: 'Ticket is not valid' },
            })
          })
        }
        return true
      })

      await client.requestRoomMembers('123456').catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, 5))

      expect(sent.filter(m => m.type === 'room-join')).toHaveLength(0)
      expect(errors).toHaveLength(1)
      expect((errors[0] as RoomRequestError).code).toBe('invalid-ticket')
    })
  })

  // ---------- 端到端：真实 WSServer ----------

  describe('端到端（真实 WSServer）', () => {
    let server: Server
    let wsServer: WSServer
    let port: number
    let activeClient: CrossTransferClient | null = null

    /** 与服务端 deriveDeviceId 一致的派生方式，用于校验 /devices/register 的返回值。 */
    function expectedDeviceId(secret: string): string {
      return createHash('sha256').update(`xfer-device:${secret}`).digest('hex').slice(0, 16)
    }

    /**
     * 令牌仍是 sha256(deviceId:tokenSecret)。测试自己铸 secret 并按同一公式算 token，
     * 这样 client 登记的 deviceId 与 WS 侧 validateToken 的期望值一致。
     */
    function issueCredentials() {
      const deviceSecret = randomBytes(32).toString('hex')
      const deviceId = expectedDeviceId(deviceSecret)
      const token = createHash('sha256').update(`${deviceId}:${TOKEN_SECRET}`).digest('hex')
      return { deviceSecret, deviceId, token }
    }

    function seedDevice(client: CrossTransferClient): { deviceSecret: string; deviceId: string; token: string } {
      const credentials = issueCredentials()
      ;(client as any).deviceSecret = credentials.deviceSecret
      ;(client as any).deviceId = credentials.deviceId
      localStorage.setItem('dsh-cross-transfer-device-secret', credentials.deviceSecret)
      return credentials
    }

    async function connectClient(client: CrossTransferClient): Promise<void> {
      activeClient = client
      const credentials = seedDevice(client)
      await client.connect(`ws://127.0.0.1:${port}${WS_PATH}`, credentials.token)
    }

    beforeEach(async () => {
      wsServer = new WSServer(new Context())
      wsServer.initialize({
        path: WS_PATH,
        tokenSecret: TOKEN_SECRET,
        maxFileSize: 1024 * 1024,
        chunkSize: 1024,
      })

      server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')

        if (url.pathname === `${WS_PATH}/devices` && req.method === 'GET') {
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ devices: wsServer.getDevices() }))
          return
        }

        if (url.pathname === `${WS_PATH}/devices/register` && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            try {
              const parsed = body.length > 0 ? JSON.parse(body) : {}
              const deviceSecret = typeof parsed.deviceSecret === 'string' && parsed.deviceSecret.length > 0
                ? parsed.deviceSecret
                : randomBytes(32).toString('hex')
              const deviceId = expectedDeviceId(deviceSecret)
              const token = createHash('sha256').update(`${deviceId}:${TOKEN_SECRET}`).digest('hex')
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({
                deviceId,
                deviceSecret,
                deviceName: parsed.deviceName || `Device-${deviceId.slice(0, 6)}`,
                token,
              }))
            } catch {
              res.statusCode = 400
              res.end(JSON.stringify({ error: { code: 'invalid-argument', message: 'Invalid JSON' } }))
            }
          })
          return
        }

        if (url.pathname === `${WS_PATH}/devices/token` && req.method === 'POST') {
          let body = ''
          req.on('data', (chunk) => { body += chunk })
          req.on('end', () => {
            const authorization = req.headers.authorization || ''
            const match = /^Bearer\s+([0-9a-f]{64})$/i.exec(authorization)
            if (!match) {
              res.statusCode = 401
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: { code: 'invalid-device', message: 'Device secret is required' } }))
              return
            }
            const deviceId = expectedDeviceId(match[1])
            const token = createHash('sha256').update(`${deviceId}:${TOKEN_SECRET}`).digest('hex')
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ token, deviceId }))
            void body
          })
          return
        }

        res.statusCode = 404
        res.end()
      })

      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (url.pathname === WS_PATH) {
          wsServer.handleUpgrade(req, socket, head)
        }
      })

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
      activeClient = null
    })

    afterEach(async () => {
      if (activeClient) {
        activeClient.disconnect()
        // 源码 bug 规避：disconnect 后 onclose 仍会调度 3s 自动重连，这里清掉
        ;(activeClient as any).serverUrl = ''
        await new Promise((resolve) => setTimeout(resolve, 30))
        const timer = (activeClient as any).reconnectTimer
        if (timer) {
          clearTimeout(timer)
          ;(activeClient as any).reconnectTimer = null
        }
        activeClient = null
      }
      wsServer.shutdown()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    })

    it('connect() 触发 connected 事件并建立 session', async () => {
      const client = createClient('E2E-Device')
      const connected = vi.fn()
      client.on('connected', connected)

      await connectClient(client)

      expect(connected).toHaveBeenCalledTimes(1)
      const session = connected.mock.calls[0][0]
      expect(session.deviceId).toBe(client.getDeviceId())
      expect(session.deviceName).toBe('E2E-Device')
      expect(typeof session.id).toBe('string')
      expect(session.id.length).toBeGreaterThan(0)

      expect(client.isConnected()).toBe(true)
      expect(client.getSession()).toEqual(session)

      const sessions = wsServer.getSessions()
      expect(sessions).toHaveLength(1)
      expect((sessions[0] as any).deviceId).toBe(client.getDeviceId())
    })

    it('fetchToken() 用 deviceSecret 换回与 deviceId 对应的 sha256 token', async () => {
      const client = createClient('E2E-Device')
      await connectClient(client)
      // serverUrl 已知后走派生出的 /devices/token。
      const credentials = issueCredentials()
      ;(client as any).deviceSecret = credentials.deviceSecret
      ;(client as any).deviceId = credentials.deviceId

      const token = await client.fetchToken()

      expect(token).toBe(credentials.token)
      expect((client as any).token).toBe(token)
    })

    it('ensureDeviceRegistered() 首次登记铸 secret、写 localStorage 并拿到 token', async () => {
      const client = createClient('E2E-Device')
      client['serverUrl'] = `ws://127.0.0.1:${port}${WS_PATH}`

      await client.ensureDeviceRegistered()

      expect(client.getDeviceId()).toMatch(/^[0-9a-f]{16}$/)
      const secret = localStore().get('dsh-cross-transfer-device-secret')!
      expect(secret).toMatch(/^[0-9a-f]{64}$/)
      expect(expectedDeviceId(secret)).toBe(client.getDeviceId())
      expect(client.getToken()).toBe(
        createHash('sha256').update(`${client.getDeviceId()}:${TOKEN_SECRET}`).digest('hex'),
      )
    })

    it('fetchDevices() 返回包含自身的设备列表并触发 deviceList 事件', async () => {
      const client = createClient('E2E-Device')
      await connectClient(client)

      const listener = vi.fn()
      client.on('deviceList', listener)

      const devices = await client.fetchDevices()

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(devices)
      expect(devices).toHaveLength(1)
      expect(devices[0]).toEqual(
        expect.objectContaining({
          deviceId: client.getDeviceId(),
          deviceName: 'E2E-Device',
          sessionCount: 1,
        }),
      )
    })
  })
})
