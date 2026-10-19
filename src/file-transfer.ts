import { Service, Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'crypto'
import { createTypedEmitter, TypedEmitter } from './typed-emitter.js'

export interface FileTransferConfig {
  maxFileSize: number
  chunkSize: number
}

export interface FileMetadata {
  fileId: string
  fileName: string
  fileSize: number
  mimeType: string
  checksum: string
  chunkCount: number
  senderDeviceId: string
  senderDeviceName: string
  createdAt: number
}

export interface TransferProgress {
  fileId: string
  receivedChunks: number
  totalChunks: number
  bytesReceived: number
  totalBytes: number
  status: 'pending' | 'receiving' | 'complete' | 'failed' | 'cancelled'
  error?: string
}

export interface FileTransferEvents {
  'transfer-initiated': [metadata: FileMetadata]
  'transfer-progress': [progress: TransferProgress]
  'transfer-complete': [fileId: string, data: Uint8Array]
  'transfer-failed': [fileId: string, error: Error]
  'transfer-cancelled': [fileId: string]
}

export class FileTransferService extends Service {
  private config: FileTransferConfig | null = null
  private pendingTransfers = new Map<string, FileMetadata>()
  private receivingBuffers = new Map<string, { metadata: FileMetadata; chunks: Map<number, Uint8Array>; receivedCount: number }>()
  private transferProgress = new Map<string, TransferProgress>()
  private emitter = createTypedEmitter<FileTransferEvents>()

  constructor(ctx: Context) {
    super(ctx, 'fileTransfer')
  }

  // TypedEmitter methods
  on<K extends keyof FileTransferEvents>(event: K, listener: (...args: FileTransferEvents[K]) => void): () => void {
    return this.emitter.on(event, listener)
  }

  off<K extends keyof FileTransferEvents>(event: K, listener: (...args: FileTransferEvents[K]) => void): void {
    this.emitter.off(event, listener)
  }

  emit<K extends keyof FileTransferEvents>(event: K, ...args: FileTransferEvents[K]): void {
    this.emitter.emit(event, ...args)
  }

  once<K extends keyof FileTransferEvents>(event: K, listener: (...args: FileTransferEvents[K]) => void): () => void {
    return this.emitter.once(event, listener)
  }

  initialize(config: FileTransferConfig): void {
    this.config = config
    this.ctx.logger.info('[cross-transfer] File transfer service initialized')
  }

  async initiateTransfer(data: {
    fileName: string
    fileSize: number
    mimeType: string
    checksum: string
    senderDeviceId: string
    senderDeviceName: string
    targetDeviceId?: string
  }): Promise<{ fileId: string; chunkSize: number; uploadUrl?: string }> {
    if (!this.config) throw new Error('Service not initialized')

    if (data.fileSize > this.config.maxFileSize) {
      throw new Error(`File size exceeds maximum allowed (${this.config.maxFileSize} bytes)`)
    }

    const chunkCount = Math.ceil(data.fileSize / this.config.chunkSize)
    const fileId = this.generateFileId()

    const metadata: FileMetadata = {
      fileId,
      fileName: data.fileName,
      fileSize: data.fileSize,
      mimeType: data.mimeType,
      checksum: data.checksum,
      chunkCount,
      senderDeviceId: data.senderDeviceId,
      senderDeviceName: data.senderDeviceName,
      createdAt: Date.now()
    }

    this.pendingTransfers.set(fileId, metadata)

    const progress: TransferProgress = {
      fileId,
      receivedChunks: 0,
      totalChunks: chunkCount,
      bytesReceived: 0,
      totalBytes: data.fileSize,
      status: 'pending'
    }
    this.transferProgress.set(fileId, progress)

    this.emit('transfer-initiated', metadata)

    this.ctx.logger.info(`[cross-transfer] File transfer initiated: ${data.fileName} (${fileId})`)

    return {
      fileId,
      chunkSize: this.config.chunkSize
    }
  }

  async receiveChunk(fileId: string, chunkIndex: number, chunkData: Uint8Array): Promise<{ success: boolean; progress: TransferProgress }> {
    const metadata = this.pendingTransfers.get(fileId)
    if (!metadata) {
      throw new Error('Transfer not found')
    }

    if (chunkIndex >= metadata.chunkCount) {
      throw new Error('Invalid chunk index')
    }

    let buffer = this.receivingBuffers.get(fileId)
    if (!buffer) {
      buffer = {
        metadata,
        chunks: new Map(),
        receivedCount: 0
      }
      this.receivingBuffers.set(fileId, buffer)
    }

    // Verify chunk size (last chunk can be smaller)
    const expectedSize = chunkIndex === metadata.chunkCount - 1
      ? metadata.fileSize - chunkIndex * this.config!.chunkSize
      : this.config!.chunkSize

    if (chunkData.length !== expectedSize) {
      throw new Error(`Chunk size mismatch: expected ${expectedSize}, got ${chunkData.length}`)
    }

    buffer.chunks.set(chunkIndex, chunkData)
    buffer.receivedCount++

    const progress: TransferProgress = {
      fileId,
      receivedChunks: buffer.receivedCount,
      totalChunks: metadata.chunkCount,
      bytesReceived: buffer.receivedCount * this.config!.chunkSize,
      totalBytes: metadata.fileSize,
      status: 'receiving'
    }
    this.transferProgress.set(fileId, progress)

    this.emit('transfer-progress', progress)

    // Check if complete
    if (buffer.receivedCount === metadata.chunkCount) {
      await this.completeTransfer(fileId, buffer)
    }

    return { success: true, progress }
  }

  private async completeTransfer(fileId: string, buffer: { metadata: FileMetadata; chunks: Map<number, Uint8Array>; receivedCount: number }): Promise<void> {
    // Reassemble file
    const chunks: Uint8Array[] = []
    for (let i = 0; i < buffer.metadata.chunkCount; i++) {
      const chunk = buffer.chunks.get(i)
      if (!chunk) {
        throw new Error(`Missing chunk ${i}`)
      }
      chunks.push(chunk)
    }

    const fileData = new Uint8Array(buffer.metadata.fileSize)
    let offset = 0
    for (const chunk of chunks) {
      fileData.set(chunk, offset)
      offset += chunk.length
    }

    // Verify checksum
    const computedChecksum = this.computeChecksum(fileData)
    if (computedChecksum !== buffer.metadata.checksum) {
      const error = new Error('Checksum verification failed')
      this.transferProgress.set(fileId, {
        ...this.transferProgress.get(fileId)!,
        status: 'failed',
        error: 'Checksum mismatch'
      })
      this.emit('transfer-failed', fileId, error)
      throw error
    }

    // Update progress
    this.transferProgress.set(fileId, {
      fileId,
      receivedChunks: buffer.metadata.chunkCount,
      totalChunks: buffer.metadata.chunkCount,
      bytesReceived: buffer.metadata.fileSize,
      totalBytes: buffer.metadata.fileSize,
      status: 'complete'
    })

    this.emit('transfer-complete', fileId, fileData)
    this.emit('transfer-progress', this.transferProgress.get(fileId)!)

    // Cleanup
    this.pendingTransfers.delete(fileId)
    this.receivingBuffers.delete(fileId)

    this.ctx.logger.info(`[cross-transfer] File transfer complete: ${buffer.metadata.fileName} (${fileId})`)
  }

  getProgress(fileId: string): TransferProgress | undefined {
    return this.transferProgress.get(fileId)
  }

  getPendingTransfers(): FileMetadata[] {
    return Array.from(this.pendingTransfers.values())
  }

  cancelTransfer(fileId: string): boolean {
    const progress = this.transferProgress.get(fileId)
    if (progress && progress.status === 'receiving') {
      this.transferProgress.set(fileId, { ...progress, status: 'cancelled' })
      this.pendingTransfers.delete(fileId)
      this.receivingBuffers.delete(fileId)
      this.emit('transfer-cancelled', fileId)
      return true
    }
    return false
  }

  private computeChecksum(data: Uint8Array): string {
    return createHash('sha256').update(Buffer.from(data)).digest('hex')
  }

  private generateFileId(): string {
    return randomBytes(16).toString('hex')
  }

  shutdown(): void {
    this.pendingTransfers.clear()
    this.receivingBuffers.clear()
    this.transferProgress.clear()
    this.ctx.logger.info('[cross-transfer] File transfer service shut down')
  }
}