import React, { useState, useEffect, useCallback } from 'react'
import { CrossTransferClient, FileTransferInfo, PeerDevice } from './CrossTransferClient.js'

interface FileTransferPanelProps {
  client: CrossTransferClient
}

export const FileTransferPanel: React.FC<FileTransferPanelProps> = ({ client }) => {
  const [devices, setDevices] = useState<PeerDevice[]>([])
  const [selectedDevice, setSelectedDevice] = useState<string>('')
  const [file, setFile] = useState<File | null>(null)
  const [transfers, setTransfers] = useState<Map<string, FileTransferInfo>>(new Map())
  const [dragActive, setDragActive] = useState(false)

  useEffect(() => {
    const handleDeviceList = (deviceList: PeerDevice[]) => {
      setDevices(deviceList.filter(d => d.deviceId !== client.getDeviceId()))
      if (!selectedDevice && deviceList.length > 0) {
        setSelectedDevice(deviceList[0].deviceId)
      }
    }

    const handleFileOffer = (info: FileTransferInfo, fromDeviceId: string) => {
      setTransfers(prev => new Map(prev).set(info.fileId, info))
    }

    const handleFileProgress = (fileId: string, progress: { received: number; total: number; percentage: number }) => {
      setTransfers(prev => {
        const next = new Map(prev)
        const info = next.get(fileId)
        if (info) {
          next.set(fileId, { ...info, progress: progress.percentage, status: 'receiving', receivedChunks: progress.received })
        }
        return next
      })
    }

    const handleFileComplete = (fileId: string, data: Uint8Array) => {
      setTransfers(prev => {
        const next = new Map(prev)
        const info = next.get(fileId)
        if (info) {
          next.set(fileId, { ...info, status: 'complete', progress: 100 })
          // Trigger download
          // Copy into a plain ArrayBuffer view: a Uint8Array over a SharedArrayBuffer
          // is not a valid BlobPart under the DOM lib types.
          const blob = new Blob([new Uint8Array(data)], { type: info.mimeType })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = info.fileName
          a.click()
          URL.revokeObjectURL(url)
        }
        return next
      })
    }

    const handleFileError = (fileId: string, error: string) => {
      setTransfers(prev => {
        const next = new Map(prev)
        const info = next.get(fileId)
        if (info) {
          next.set(fileId, { ...info, status: 'failed' })
        }
        return next
      })
    }

    client.on('deviceList', handleDeviceList)
    client.on('fileOffer', handleFileOffer)
    client.on('fileProgress', handleFileProgress)
    client.on('fileComplete', handleFileComplete)
    client.on('fileError', handleFileError)

    client.fetchDevices()

    return () => {
      client.off('deviceList', handleDeviceList)
      client.off('fileOffer', handleFileOffer)
      client.off('fileProgress', handleFileProgress)
      client.off('fileComplete', handleFileComplete)
      client.off('fileError', handleFileError)
    }
  }, [client, selectedDevice])

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setDragActive(true)
    } else if (e.type === 'dragleave') {
      setDragActive(false)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragActive(false)

    if (e.dataTransfer.files.length > 0 && selectedDevice) {
      const droppedFile = e.dataTransfer.files[0]
      setFile(droppedFile)
      sendFile(droppedFile)
    }
  }

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && selectedDevice) {
      const selectedFile = e.target.files[0]
      setFile(selectedFile)
      sendFile(selectedFile)
    }
  }

  const sendFile = async (fileToSend: File) => {
    if (!selectedDevice) return

    try {
      await client.sendFile(fileToSend, selectedDevice)
    } catch (error) {
      console.error('Failed to send file:', error)
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      <h3 style={{ margin: 0 }}>File Transfer</h3>

      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          Target Device:
          <select
            value={selectedDevice}
            onChange={(e) => setSelectedDevice(e.target.value)}
            style={{ padding: '4px 8px', minWidth: '200px' }}
          >
            {devices.map(d => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.deviceName} ({d.deviceId.slice(0, 8)})
              </option>
            ))}
          </select>
        </label>

        <button
          onClick={() => client.fetchDevices()}
          style={{ padding: '4px 12px' }}
        >
          Refresh
        </button>
      </div>

      <div
        onDragEnter={handleDrag}
        onDragLeave={handleDrag}
        onDragOver={handleDrag}
        onDrop={handleDrop}
        style={{
          border: `2px dashed ${dragActive ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-caption)'}`,
          borderRadius: '8px',
          padding: '32px',
          textAlign: 'center',
          backgroundColor: dragActive ? 'var(--dsw-alias-state-business-tertiary)' : 'var(--dsw-alias-bg-layer-2)',
          transition: 'all 0.2s',
          flex: 1
        }}
      >
        <input
          type="file"
          onChange={handleFileSelect}
          style={{ display: 'none' }}
          id="file-input"
          ref={(el) => {
            if (el) el.style.display = 'none'
          }}
        />
        <label htmlFor="file-input" style={{ cursor: 'pointer' }}>
          <p style={{ margin: '0 0 8px', fontSize: '18px', color: dragActive ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-primary)' }}>
            {dragActive ? 'Drop file here' : 'Drag & drop a file or click to select'}
          </p>
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px' }}>
            Max file size: 1GB
          </p>
        </label>
      </div>

      {file && (
        <div style={{ padding: '12px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '8px' }}>
          <p style={{ margin: '0 0 4px', fontWeight: 500 }}>{file.name}</p>
          <p style={{ margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: '14px' }}>
            {formatSize(file.size)} • {file.type || 'Unknown type'}
          </p>
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        <h4 style={{ margin: '0 0 12px' }}>Transfer History</h4>
        {transfers.size === 0 ? (
          <p style={{ color: 'var(--dsw-alias-label-tertiary)', textAlign: 'center', padding: '24px' }}>No transfers yet</p>
        ) : (
          Array.from(transfers.values()).map(info => (
            <div
              key={info.fileId}
              style={{
                padding: '12px',
                borderBottom: '1px solid var(--dsw-alias-border-l1)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
            >
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 4px', fontWeight: 500 }}>{info.fileName}</p>
                <p style={{ margin: 0, fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' }}>
                  {formatSize(info.fileSize)} • {info.senderDeviceName} → You
                </p>
                <div style={{ marginTop: '8px', height: '6px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${info.progress}%`,
                      height: '100%',
                      background: info.status === 'complete' ? 'var(--dsw-alias-state-success-primary)' : info.status === 'failed' ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-button-primary-fill)',
                      transition: 'width 0.3s'
                    }}
                  />
                </div>
              </div>
              <span
                style={{
                  padding: '2px 8px',
                  borderRadius: '12px',
                  fontSize: '12px',
                  fontWeight: 500,
                  background: info.status === 'complete' ? 'var(--dsw-alias-state-success-tertiary)' : info.status === 'failed' ? 'var(--dsw-alias-interactive-bg-hover-danger)' : info.status === 'receiving' ? 'var(--dsw-alias-state-business-tertiary)' : 'var(--dsw-alias-state-warn-tertiary)',
                  color: info.status === 'complete' ? 'var(--dsw-alias-label-primary)' : info.status === 'failed' ? 'var(--dsw-alias-state-error-primary)' : info.status === 'receiving' ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-state-warn-label)'
                }}
              >
                {info.status}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}