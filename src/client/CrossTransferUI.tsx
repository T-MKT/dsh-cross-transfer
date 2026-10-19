import React, { useState } from 'react'
import { CrossTransferClient, PeerDevice } from './CrossTransferClient.js'
import { FileTransferPanel } from './FileTransferPanel.js'
import { ChatPanel } from './ChatPanel.js'
import { RoomPanel } from './RoomPanel.js'
import { GitSyncPanel } from './GitSyncPanel.js'
import { DeviceList } from './DeviceList.js'

interface CrossTransferUIProps {
  client: CrossTransferClient
}

export const CrossTransferUI: React.FC<CrossTransferUIProps> = ({ client }) => {
  const [activeTab, setActiveTab] = useState<'files' | 'rooms' | 'chat' | 'git'>('files')
  const [selectedDevice, setSelectedDevice] = useState<PeerDevice | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  const tabs = [
    { id: 'files', label: 'Files', icon: '📁' },
    { id: 'rooms', label: 'Rooms', icon: '🚪' },
    { id: 'chat', label: 'Chat', icon: '💬' },
    { id: 'git', label: 'Git Sync', icon: '🔄' }
  ] as const

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: '#fff',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    }}>
      {/* Header */}
      <header style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '12px 16px',
        borderBottom: '1px solid #eee',
        background: '#fafafa'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            style={{
              padding: '6px',
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              borderRadius: '4px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>
          <h1 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>Cross Transfer</h1>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px' }}>
            <span
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: client.isConnected() ? '#28a745' : '#dc3545'
              }}
            />
            {client.isConnected() ? 'Connected' : 'Disconnected'}
          </div>
          <div style={{ fontSize: '12px', color: '#666' }}>
            {client.getDeviceName()}
          </div>
          {!client.isConnected() && (
            <button
              onClick={async () => {
                try {
                  await client.reconnect()
                } catch (e) {
                  console.error('Reconnect failed:', e)
                }
              }}
              style={{
                padding: '6px 12px',
                background: '#007bff',
                color: '#fff',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer'
              }}
            >
              Reconnect
            </button>
          )}
        </div>
      </header>

      {/* Main Content */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar - Device List */}
        {sidebarOpen && (
          <DeviceList
            client={client}
            onDeviceSelect={setSelectedDevice}
          />
        )}

        {/* Main Panel */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {/* Tab Bar */}
          <div style={{
            display: 'flex',
            borderBottom: '1px solid #eee',
            background: '#fafafa',
            padding: '0 16px'
          }}>
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as typeof activeTab)}
                style={{
                  padding: '12px 20px',
                  border: 'none',
                  background: 'transparent',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: activeTab === tab.id ? 600 : 400,
                  color: activeTab === tab.id ? '#007bff' : '#666',
                  borderBottom: activeTab === tab.id ? '2px solid #007bff' : '2px solid transparent',
                  marginBottom: '-1px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.15s'
                }}
              >
                <span>{tab.icon}</span>
                <span>{tab.label}</span>
              </button>
            ))}
          </div>

          {/* Tab Content */}
          <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
            {activeTab === 'files' && (
              <FileTransferPanel client={client} />
            )}
            {activeTab === 'rooms' && (
              <RoomPanel client={client} />
            )}
            {activeTab === 'chat' && (
              <ChatPanel client={client} onRequireRooms={() => setActiveTab('rooms')} />
            )}
            {activeTab === 'git' && (
              <GitSyncPanel client={client} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}