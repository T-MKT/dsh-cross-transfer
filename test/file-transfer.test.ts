import { describe, it, expect } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createHash } from 'crypto'
import { FileTransferService, type FileMetadata, type TransferProgress } from '../src/file-transfer.js'

const CONFIG = { maxFileSize: 1048576, chunkSize: 1024 }

function makePayload(size: number): Buffer {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i++) buf[i] = (i * 7 + 13) % 256
  return buf
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function createService(initialize = true): FileTransferService {
  const ctx = new Context()
  const service = new FileTransferService(ctx)
  if (initialize) service.initialize({ ...CONFIG })
  return service
}

function initiateInfo(
  service: FileTransferService,
  payload: Buffer,
  fileName = 'test.bin'
): Promise<{ fileId: string; chunkSize: number; uploadUrl?: string }> {
  return service.initiateTransfer({
    fileName,
    fileSize: payload.length,
    mimeType: 'application/octet-stream',
    checksum: sha256Hex(payload),
    senderDeviceId: 'device-a',
    senderDeviceName: 'Sender A'
  })
}

describe('FileTransferService', () => {
  // ---------- initiateTransfer ----------

  it('initiateTransfer 成功时返回 fileId 和 chunkSize', async () => {
    const service = createService()
    const result = await initiateInfo(service, makePayload(2500))

    expect(result.fileId).toMatch(/^[0-9a-f]{32}$/)
    expect(result.chunkSize).toBe(1024)
    expect(result.uploadUrl).toBeUndefined()
  })

  it('initiateTransfer 未初始化时抛出 Service not initialized', async () => {
    const service = createService(false)
    await expect(initiateInfo(service, makePayload(100))).rejects.toThrow('Service not initialized')
  })

  it('initiateTransfer fileSize 超过 maxFileSize 时抛错', async () => {
    const service = createService()
    const tooBig = CONFIG.maxFileSize + 1
    await expect(
      service.initiateTransfer({
        fileName: 'huge.bin',
        fileSize: tooBig,
        mimeType: 'application/octet-stream',
        checksum: sha256Hex(Buffer.alloc(0)),
        senderDeviceId: 'device-a',
        senderDeviceName: 'Sender A'
      })
    ).rejects.toThrow('File size exceeds maximum allowed (1048576 bytes)')
  })

  it('initiateTransfer fileSize 等于 maxFileSize 时成功', async () => {
    const service = createService()
    const result = await service.initiateTransfer({
      fileName: 'max.bin',
      fileSize: CONFIG.maxFileSize,
      mimeType: 'application/octet-stream',
      checksum: sha256Hex(Buffer.alloc(0)),
      senderDeviceId: 'device-a',
      senderDeviceName: 'Sender A'
    })
    expect(result.fileId).toMatch(/^[0-9a-f]{32}$/)
    expect(result.chunkSize).toBe(1024)
  })

  it('initiateTransfer 触发 transfer-initiated 事件并携带 metadata', async () => {
    const service = createService()
    const payload = makePayload(2500)
    const events: FileMetadata[] = []
    service.on('transfer-initiated', metadata => events.push(metadata))

    const { fileId } = await initiateInfo(service, payload, 'photo.jpg')

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      fileId,
      fileName: 'photo.jpg',
      fileSize: 2500,
      mimeType: 'application/octet-stream',
      checksum: sha256Hex(payload),
      chunkCount: 3,
      senderDeviceId: 'device-a',
      senderDeviceName: 'Sender A'
    })
    expect(events[0].createdAt).toBeGreaterThan(0)
  })

  // ---------- 完整传输流程 ----------

  it('完整传输流程：2500 字节分 3 块传输，transfer-complete 携带与原始一致的数据', async () => {
    const service = createService()
    const payload = makePayload(2500)
    const completed: { fileId: string; data: Uint8Array }[] = []
    service.on('transfer-complete', (fileId, data) => completed.push({ fileId, data }))

    const { fileId, chunkSize } = await initiateInfo(service, payload)
    expect(chunkSize).toBe(1024)

    // 2500 / 1024 => 3 chunks: 1024 + 1024 + 452
    for (let i = 0; i < 3; i++) {
      const start = i * 1024
      const end = Math.min(start + 1024, payload.length)
      const res = await service.receiveChunk(fileId, i, payload.subarray(start, end))
      expect(res.success).toBe(true)
    }

    expect(completed).toHaveLength(1)
    expect(completed[0].fileId).toBe(fileId)
    expect(completed[0].data.length).toBe(2500)
    expect(Buffer.from(completed[0].data)).toEqual(payload)

    const progress = service.getProgress(fileId)!
    expect(progress.status).toBe('complete')
    expect(progress.receivedChunks).toBe(3)
    expect(progress.bytesReceived).toBe(2500)
    expect(progress.totalBytes).toBe(2500)
  })

  it('最后一块小于 chunkSize 也能成功完成', async () => {
    const service = createService()
    const payload = makePayload(1100) // 1024 + 76
    const completed: Uint8Array[] = []
    service.on('transfer-complete', (_fileId, data) => completed.push(data))

    const { fileId } = await initiateInfo(service, payload)

    const first = await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    expect(first.success).toBe(true)
    expect(first.progress.status).toBe('receiving')

    const last = await service.receiveChunk(fileId, 1, payload.subarray(1024, 1100))
    expect(last.success).toBe(true)

    expect(completed).toHaveLength(1)
    expect(completed[0].length).toBe(1100)
    expect(Buffer.from(completed[0])).toEqual(payload)
    expect(service.getProgress(fileId)?.status).toBe('complete')
  })

  it('乱序到达的 chunk（先 chunk 1 再 chunk 0）也能正确完成', async () => {
    const service = createService()
    const payload = makePayload(1500) // 1024 + 476
    const completed: Uint8Array[] = []
    service.on('transfer-complete', (_fileId, data) => completed.push(data))

    const { fileId } = await initiateInfo(service, payload)

    const second = await service.receiveChunk(fileId, 1, payload.subarray(1024, 1500))
    expect(second.success).toBe(true)
    expect(second.progress.receivedChunks).toBe(1)
    expect(service.getProgress(fileId)?.status).toBe('receiving')

    const first = await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    expect(first.success).toBe(true)

    expect(completed).toHaveLength(1)
    expect(Buffer.from(completed[0])).toEqual(payload)
    expect(service.getProgress(fileId)?.status).toBe('complete')
  })

  // ---------- 错误路径 ----------

  it('chunk 实际大小与期望不符时抛出 Chunk size mismatch', async () => {
    const service = createService()
    const payload = makePayload(2500) // chunkCount 3, 最后一块 452
    const { fileId } = await initiateInfo(service, payload)

    // 普通块应为 1024 字节，实际 100 字节
    await expect(service.receiveChunk(fileId, 0, new Uint8Array(100))).rejects.toThrow(
      'Chunk size mismatch: expected 1024, got 100'
    )

    // 最后一块应为 452 字节，实际 100 字节
    await expect(service.receiveChunk(fileId, 2, new Uint8Array(100))).rejects.toThrow(
      'Chunk size mismatch: expected 452, got 100'
    )

    // 大小不符的块不会被计入进度
    expect(service.getProgress(fileId)?.receivedChunks).toBe(0)
    expect(service.getProgress(fileId)?.status).toBe('pending')
  })

  it('chunkIndex 超出 chunkCount 时抛出 Invalid chunk index', async () => {
    const service = createService()
    const payload = makePayload(2500) // chunkCount 3 => 合法索引 0..2
    const { fileId } = await initiateInfo(service, payload)

    await expect(service.receiveChunk(fileId, 3, new Uint8Array(1024))).rejects.toThrow(
      'Invalid chunk index'
    )
    await expect(service.receiveChunk(fileId, 99, new Uint8Array(1024))).rejects.toThrow(
      'Invalid chunk index'
    )
  })

  it('未知 fileId 抛出 Transfer not found', async () => {
    const service = createService()
    await expect(
      service.receiveChunk('does-not-exist', 0, new Uint8Array(1024))
    ).rejects.toThrow('Transfer not found')
  })

  it('checksum 不匹配时抛错并触发 transfer-failed 事件', async () => {
    const service = createService()
    const payload = makePayload(2500)
    const failed: { fileId: string; error: Error }[] = []
    service.on('transfer-failed', (fileId, error) => failed.push({ fileId, error }))

    const { fileId } = await service.initiateTransfer({
      fileName: 'tampered.bin',
      fileSize: payload.length,
      mimeType: 'application/octet-stream',
      checksum: sha256Hex(Buffer.from('tampered-content')),
      senderDeviceId: 'device-a',
      senderDeviceName: 'Sender A'
    })

    await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    await service.receiveChunk(fileId, 1, payload.subarray(1024, 2048))
    await expect(service.receiveChunk(fileId, 2, payload.subarray(2048, 2500))).rejects.toThrow(
      'Checksum verification failed'
    )

    expect(failed).toHaveLength(1)
    expect(failed[0].fileId).toBe(fileId)
    expect(failed[0].error).toBeInstanceOf(Error)
    expect(failed[0].error.message).toBe('Checksum verification failed')

    expect(service.getProgress(fileId)?.status).toBe('failed')
    expect(service.getProgress(fileId)?.error).toBe('Checksum mismatch')
  })

  // ---------- cancelTransfer ----------

  it('cancelTransfer 在接收中返回 true 并触发 transfer-cancelled', async () => {
    const service = createService()
    const payload = makePayload(2500)
    const cancelled: string[] = []
    service.on('transfer-cancelled', fileId => cancelled.push(fileId))

    const { fileId } = await initiateInfo(service, payload)
    await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    expect(service.getProgress(fileId)?.status).toBe('receiving')

    expect(service.cancelTransfer(fileId)).toBe(true)
    expect(cancelled).toEqual([fileId])
    expect(service.getProgress(fileId)?.status).toBe('cancelled')

    // 取消后传输被移除，后续 chunk 会被拒绝
    await expect(
      service.receiveChunk(fileId, 1, payload.subarray(1024, 2048))
    ).rejects.toThrow('Transfer not found')
  })

  it('cancelTransfer 在非接收中状态（pending）返回 false', async () => {
    const service = createService()
    const cancelled: string[] = []
    service.on('transfer-cancelled', fileId => cancelled.push(fileId))

    const { fileId } = await initiateInfo(service, makePayload(2500))
    expect(service.getProgress(fileId)?.status).toBe('pending')

    expect(service.cancelTransfer(fileId)).toBe(false)
    expect(cancelled).toHaveLength(0)
    // 传输未被移除
    expect(service.getPendingTransfers().map(t => t.fileId)).toContain(fileId)
  })

  it('cancelTransfer 在完成后返回 false，未知 fileId 也返回 false', async () => {
    const service = createService()
    const payload = makePayload(1100)
    const cancelled: string[] = []
    service.on('transfer-cancelled', fileId => cancelled.push(fileId))

    const { fileId } = await initiateInfo(service, payload)
    await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    await service.receiveChunk(fileId, 1, payload.subarray(1024, 1100))
    expect(service.getProgress(fileId)?.status).toBe('complete')

    expect(service.cancelTransfer(fileId)).toBe(false)
    expect(service.cancelTransfer('no-such-file')).toBe(false)
    expect(cancelled).toHaveLength(0)
  })

  // ---------- 状态查询 ----------

  it('getProgress 状态随传输推进正确更新', async () => {
    const service = createService()
    const payload = makePayload(2500)
    const { fileId } = await initiateInfo(service, payload)

    // 未知 fileId
    expect(service.getProgress('missing')).toBeUndefined()

    // pending
    expect(service.getProgress(fileId)).toMatchObject({
      fileId,
      receivedChunks: 0,
      totalChunks: 3,
      bytesReceived: 0,
      totalBytes: 2500,
      status: 'pending'
    })

    // receiving
    await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    expect(service.getProgress(fileId)).toMatchObject({
      receivedChunks: 1,
      totalChunks: 3,
      status: 'receiving'
    })

    await service.receiveChunk(fileId, 1, payload.subarray(1024, 2048))
    expect(service.getProgress(fileId)).toMatchObject({
      receivedChunks: 2,
      status: 'receiving'
    })

    // complete（完成记录保留在 progress map 中）
    await service.receiveChunk(fileId, 2, payload.subarray(2048, 2500))
    expect(service.getProgress(fileId)).toMatchObject({
      receivedChunks: 3,
      totalChunks: 3,
      bytesReceived: 2500,
      totalBytes: 2500,
      status: 'complete'
    })
  })

  it('getPendingTransfers 正确反映待传输列表', async () => {
    const service = createService()
    expect(service.getPendingTransfers()).toHaveLength(0)

    const payloadA = makePayload(2500)
    const { fileId: idA } = await initiateInfo(service, payloadA, 'a.bin')

    let pending = service.getPendingTransfers()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      fileId: idA,
      fileName: 'a.bin',
      fileSize: 2500,
      chunkCount: 3,
      mimeType: 'application/octet-stream',
      senderDeviceId: 'device-a',
      senderDeviceName: 'Sender A',
      checksum: sha256Hex(payloadA)
    })

    const payloadB = makePayload(100)
    const { fileId: idB } = await initiateInfo(service, payloadB, 'b.txt')
    expect(service.getPendingTransfers()).toHaveLength(2)

    // 完成传输 A 后从待传输列表移除
    await service.receiveChunk(idA, 0, payloadA.subarray(0, 1024))
    await service.receiveChunk(idA, 1, payloadA.subarray(1024, 2048))
    await service.receiveChunk(idA, 2, payloadA.subarray(2048, 2500))

    pending = service.getPendingTransfers()
    expect(pending.map(t => t.fileId)).toEqual([idB])
  })

  // ---------- transfer-progress 事件 ----------

  it('transfer-progress 事件按块触发并在完成时以 complete 状态收尾', async () => {
    const service = createService()
    const payload = makePayload(2500)
    const progresses: TransferProgress[] = []
    service.on('transfer-progress', p => progresses.push(p))

    const { fileId } = await initiateInfo(service, payload)
    await service.receiveChunk(fileId, 0, payload.subarray(0, 1024))
    await service.receiveChunk(fileId, 1, payload.subarray(1024, 2048))
    await service.receiveChunk(fileId, 2, payload.subarray(2048, 2500))

    // 每块一个 receiving 进度 + 完成时一个 complete 进度
    expect(progresses).toHaveLength(4)
    expect(progresses[0]).toMatchObject({ fileId, receivedChunks: 1, status: 'receiving' })
    expect(progresses[1]).toMatchObject({ fileId, receivedChunks: 2, status: 'receiving' })
    expect(progresses[2]).toMatchObject({ fileId, receivedChunks: 3, status: 'receiving' })
    expect(progresses[3]).toMatchObject({
      fileId,
      receivedChunks: 3,
      totalChunks: 3,
      bytesReceived: 2500,
      status: 'complete'
    })
  })
})
