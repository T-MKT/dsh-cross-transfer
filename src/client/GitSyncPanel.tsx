import React, { useState, useEffect } from 'react'
import { CrossTransferClient, RepoConfig, SyncResult } from './CrossTransferClient.js'

interface GitSyncPanelProps {
  client: CrossTransferClient
}

export const GitSyncPanel: React.FC<GitSyncPanelProps> = ({ client }) => {
  const [repos, setRepos] = useState<RepoConfig[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>('')
  const [showRegisterDialog, setShowRegisterDialog] = useState(false)
  const [registerForm, setRegisterForm] = useState({
    name: '',
    localPath: '',
    remoteUrl: '',
    branch: 'main',
    authType: 'token' as 'token' | 'ssh',
    username: '',
    token: '',
    autoSync: false
  })
  const [syncResults, setSyncResults] = useState<Record<string, SyncResult>>({})
  const [syncing, setSyncing] = useState<string | null>(null)
  const [syncProgress, setSyncProgress] = useState<Record<string, { phase: string; loaded: number; total: number }>>({})

  useEffect(() => {
    const handleRepoList = (repoList: RepoConfig[]) => {
      setRepos(repoList)
      if (!selectedRepo && repoList.length > 0) {
        setSelectedRepo(repoList[0].repoId)
      }
    }

    const handleSyncProgress = (repoId: string, progress: { phase: string; loaded: number; total: number }) => {
      setSyncProgress(prev => ({ ...prev, [repoId]: progress }))
    }

    const handleSyncComplete = (result: SyncResult) => {
      setSyncResults(prev => ({ ...prev, [result.repoId]: result }))
      setSyncing(null)
      setSyncProgress(prev => ({ ...prev, [result.repoId]: { phase: 'complete', loaded: 100, total: 100 } }))
    }

    const handleSyncError = (repoId: string, error: string, operation: string) => {
      setSyncResults(prev => ({
        ...prev,
        [repoId]: { success: false, operation, repoId, error }
      }))
      setSyncing(null)
    }

    const handleSyncConflict = (repoId: string, conflicts: string[]) => {
      setSyncResults(prev => ({
        ...prev,
        [repoId]: { success: false, operation: 'pull', repoId, error: 'Conflicts detected', conflicts }
      }))
    }

    client.on('repoList', handleRepoList)
    client.on('syncProgress', handleSyncProgress)
    client.on('syncComplete', handleSyncComplete)
    client.on('syncError', handleSyncError)
    client.on('syncConflict', handleSyncConflict)

    client.requestRepoList()

    return () => {
      client.off('repoList', handleRepoList)
      client.off('syncProgress', handleSyncProgress)
      client.off('syncComplete', handleSyncComplete)
      client.off('syncError', handleSyncError)
      client.off('syncConflict', handleSyncConflict)
    }
  }, [client])

  const handleRegister = async () => {
    try {
      await client.registerRepo(registerForm)
      setShowRegisterDialog(false)
      setRegisterForm({ name: '', localPath: '', remoteUrl: '', branch: 'main', authType: 'token', username: '', token: '', autoSync: false })
    } catch (error) {
      console.error('Failed to register repo:', error)
    }
  }

  const handleSync = async (operation: 'fetch' | 'pull' | 'push' | 'status') => {
    if (!selectedRepo) return
    setSyncing(selectedRepo)
    setSyncProgress(prev => ({ ...prev, [selectedRepo]: { phase: operation, loaded: 0, total: 100 } }))
    try {
      await client.syncRepo(selectedRepo, operation)
    } catch (error) {
      console.error('Sync failed:', error)
      setSyncing(null)
    }
  }

  const getStatusColor = (result?: SyncResult) => {
    if (!result) return '#6c757d'
    if (result.success) return '#28a745'
    return '#dc3545'
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Git Sync</h3>
        <button onClick={() => setShowRegisterDialog(true)} style={{ padding: '6px 12px', background: '#28a745', color: '#fff', border: 'none', borderRadius: '4px' }}>
          + Add Repository
        </button>
      </div>

      <div style={{ border: '1px solid #ddd', borderRadius: '8px', overflow: 'hidden' }}>
        <div style={{ padding: '12px 16px', borderBottom: '1px solid #eee' }}>
          <select
            value={selectedRepo}
            onChange={(e) => setSelectedRepo(e.target.value)}
            style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
          >
            {repos.map(repo => (
              <option key={repo.repoId} value={repo.repoId}>
                {repo.name} ({repo.remoteUrl})
              </option>
            ))}
          </select>
        </div>

        {selectedRepo && repos.find(r => r.repoId === selectedRepo) && (
          <div style={{ padding: '16px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginBottom: '16px' }}>
              <div>
                <strong>Local Path:</strong>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#666', wordBreak: 'break-all' }}>
                  {repos.find(r => r.repoId === selectedRepo)?.localPath}
                </p>
              </div>
              <div>
                <strong>Branch:</strong>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#666' }}>
                  {repos.find(r => r.repoId === selectedRepo)?.branch}
                </p>
              </div>
              <div>
                <strong>Auto-sync:</strong>
                <p style={{ margin: '4px 0 0', fontSize: '13px', color: '#666' }}>
                  {repos.find(r => r.repoId === selectedRepo)?.autoSync ? 'Enabled' : 'Disabled'}
                </p>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '16px' }}>
              <button onClick={() => handleSync('fetch')} disabled={!!syncing} style={{ padding: '8px 16px' }}>Fetch</button>
              <button onClick={() => handleSync('pull')} disabled={!!syncing} style={{ padding: '8px 16px', background: '#28a745', color: '#fff', border: 'none', borderRadius: '4px' }}>Pull</button>
              <button onClick={() => handleSync('push')} disabled={!!syncing} style={{ padding: '8px 16px' }}>Push</button>
              <button onClick={() => handleSync('status')} disabled={!!syncing} style={{ padding: '8px 16px' }}>Status</button>
            </div>

            {syncing && syncProgress[syncing] && (
              <div style={{ marginBottom: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                  <span>{syncProgress[syncing].phase}</span>
                  <span>{Math.round((syncProgress[syncing].loaded / syncProgress[syncing].total) * 100)}%</span>
                </div>
                <div style={{ height: '6px', background: '#eee', borderRadius: '3px', overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${(syncProgress[syncing].loaded / syncProgress[syncing].total) * 100}%`,
                      height: '100%',
                      background: '#007bff',
                      transition: 'width 0.3s'
                    }}
                  />
                </div>
              </div>
            )}

            {syncResults[selectedRepo] && (
              <div style={{ padding: '12px', background: '#f8f9fa', borderRadius: '4px', fontSize: '13px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', maxHeight: '300px', overflow: 'auto' }}>
                <div style={{ color: getStatusColor(syncResults[selectedRepo]), fontWeight: 'bold', marginBottom: '8px' }}>
                  {syncResults[selectedRepo].success ? 'Success' : 'Failed'} - {syncResults[selectedRepo].operation}
                </div>
                <div>{syncResults[selectedRepo].output || syncResults[selectedRepo].error || 'No output'}</div>
                {syncResults[selectedRepo].conflicts && syncResults[selectedRepo].conflicts.length > 0 && (
                  <div style={{ marginTop: '8px', color: '#dc3545' }}>
                    <strong>Conflicts:</strong>
                    <ul style={{ margin: '4px 0 0', paddingLeft: '20px' }}>
                      {syncResults[selectedRepo].conflicts.map(c => <li key={c}>{c}</li>)}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {repos.length === 0 && (
          <div style={{ padding: '32px', textAlign: 'center', color: '#999' }}>
            No repositories configured. Click "Add Repository" to get started.
          </div>
        )}
      </div>

      {showRegisterDialog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', padding: '24px', borderRadius: '12px', minWidth: '400px', maxHeight: '90vh', overflow: 'auto' }}>
            <h3 style={{ margin: '0 0 16px' }}>Register Repository</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Name</label>
                <input
                  value={registerForm.name}
                  onChange={(e) => setRegisterForm(prev => ({ ...prev, name: e.target.value }))}
                  placeholder="My Project"
                  style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Local Path</label>
                <input
                  value={registerForm.localPath}
                  onChange={(e) => setRegisterForm(prev => ({ ...prev, localPath: e.target.value }))}
                  placeholder="/path/to/local/repo"
                  style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Remote URL</label>
                <input
                  value={registerForm.remoteUrl}
                  onChange={(e) => setRegisterForm(prev => ({ ...prev, remoteUrl: e.target.value }))}
                  placeholder="https://github.com/user/repo.git"
                  style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Branch</label>
                <input
                  value={registerForm.branch}
                  onChange={(e) => setRegisterForm(prev => ({ ...prev, branch: e.target.value }))}
                  placeholder="main"
                  style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Authentication</label>
                <select
                  value={registerForm.authType}
                  onChange={(e) => setRegisterForm(prev => ({ ...prev, authType: e.target.value as 'token' | 'ssh' }))}
                  style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                >
                  <option value="token">Token (HTTPS)</option>
                  <option value="ssh">SSH Key</option>
                </select>
              </div>
              {registerForm.authType === 'token' && (
                <>
                  <div>
                    <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Username</label>
                    <input
                      value={registerForm.username}
                      onChange={(e) => setRegisterForm(prev => ({ ...prev, username: e.target.value }))}
                      placeholder="oauth2 or username"
                      style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', marginBottom: '4px', fontWeight: 500 }}>Token</label>
                    <input
                      type="password"
                      value={registerForm.token}
                      onChange={(e) => setRegisterForm(prev => ({ ...prev, token: e.target.value }))}
                      placeholder="Personal access token"
                      style={{ width: '100%', padding: '8px', border: '1px solid #ddd', borderRadius: '4px' }}
                    />
                  </div>
                </>
              )}
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="checkbox"
                  checked={registerForm.autoSync}
                  onChange={(e) => setRegisterForm(prev => ({ ...prev, autoSync: e.target.checked }))}
                />
                <span>Enable auto-sync (every 30s)</span>
              </label>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
              <button onClick={() => setShowRegisterDialog(false)} style={{ padding: '8px 16px' }}>Cancel</button>
              <button onClick={handleRegister} style={{ padding: '8px 16px', background: '#28a745', color: '#fff', border: 'none', borderRadius: '4px' }}>Register</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}