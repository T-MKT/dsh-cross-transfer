import React, { useState, useEffect } from 'react'
import { CrossTransferClient, PeerDevice } from './CrossTransferClient.js'

interface DeviceListProps {
  client: CrossTransferClient
  onDeviceSelect?: (device: PeerDevice) => void
}

export const DeviceList: React.FC<DeviceListProps> = ({ client, onDeviceSelect }) => {
  const [devices, setDevices] = useState<PeerDevice[]>([])
  const [currentDeviceId, setCurrentDeviceId] = useState<string>('')

  useEffect(() => {
    const handleDeviceList = (deviceList: PeerDevice[]) => {
      const others = deviceList.filter(d => d.deviceId !== client.getDeviceId())
      setDevices(others)
      setCurrentDeviceId(client.getDeviceId())
    }

    client.on('deviceList', handleDeviceList)
    client.fetchDevices()

    return () => {
      client.off('deviceList', handleDeviceList)
    }
  }, [client])

  return (
    <div style={{ padding: '12px', borderRight: '1px solid var(--dsw-alias-border-l1)', minWidth: '220px', maxWidth: '280px' }}>
      <h4 style={{ margin: '0 0 12px', fontSize: '14px' }}>
        Connected Devices ({devices.length})
      </h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div
          style={{
            padding: '8px 12px',
            background: 'var(--dsw-alias-state-business-tertiary)',
            borderRadius: '6px',
            border: '1px solid var(--dsw-alias-state-business-primary)'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' }} />
            <span style={{ fontWeight: 500, fontSize: '13px' }}>This Device</span>
          </div>
          <div style={{ marginTop: '4px', fontSize: '11px', color: 'var(--dsw-alias-label-secondary)' }}>
            {client.getDeviceName()} ({currentDeviceId.slice(0, 8)})
          </div>
        </div>
        {devices.map(device => (
          <button
            key={device.deviceId}
            onClick={() => onDeviceSelect?.(device)}
            style={{
              padding: '10px 12px',
              textAlign: 'left',
              border: '1px solid var(--dsw-alias-border-l1)',
              borderRadius: '6px',
              background: 'var(--dsw-alias-bg-layer-1)',
              cursor: 'pointer',
              transition: 'all 0.15s'
            }}
            onMouseOver={(e) => e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'}
            onMouseOut={(e) => e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-1)'}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--dsw-alias-state-success-primary)' }} />
              <span style={{ fontWeight: 500, fontSize: '13px', flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {device.deviceName}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', marginTop: '2px' }}>
              {device.capabilities.map(c => (
                <span key={c} style={{ padding: '1px 6px', background: 'var(--dsw-alias-bg-layer-2)', borderRadius: '10px', marginRight: '4px', fontSize: '10px' }}>
                  {c}
                </span>
              ))}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--dsw-alias-label-caption)', marginTop: '2px' }}>
              {device.deviceId.slice(0, 12)}...
            </div>
          </button>
        ))}
        {devices.length === 0 && (
          <div style={{ padding: '24px', textAlign: 'center', color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' }}>
            No other devices connected
          </div>
        )}
      </div>
    </div>
  )
}