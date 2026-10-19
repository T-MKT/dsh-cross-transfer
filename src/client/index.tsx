/**
 * Browser half of the cross-transfer plugin: the WebSocket client service plus
 * the React panels, mounted under `ctx.crossTransferClient`.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: these augment the cordis Context with `slots` and the SlotMap
// with `sidebar.footer.action`; the runtime values arrive from the shell.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { z } from 'zod'
import { CrossTransferClient } from './CrossTransferClient.js'
import { CrossTransferLauncher } from './CrossTransferLauncher.js'

/** Cordis plugin name. */
export const name = 'cross-transfer-client'

/**
 * Client services this half composes with. `slots` is the renderer's slot
 * registry (a cordis service, not a package to prefetch), so it belongs here
 * rather than in `dsh.client.inject`.
 */
export const inject = ['connection', 'slots']

export interface CrossTransferClientConfig {
  autoConnect?: boolean
  deviceName?: string
}

/**
 * A boot entry carries no config row, so the harness validates this schema
 * against `undefined` — a bare object schema rejects that with "expected
 * object, received undefined" and the whole plugin fails to load. `prefault`
 * supplies `{}` as the input in that case and then applies the inner defaults,
 * so an unconfigured plugin still sees `autoConnect: true`.
 *
 * The harness's own client plugins avoid this entirely by exporting no Config;
 * this half keeps one so the two switches stay settable in a config row.
 */
export const Config = z
  .object({
    autoConnect: z.boolean().default(true),
    deviceName: z.string().optional()
  })
  .prefault({})

/** The slice of the connection service this half reads (see dsh-client-connection). */
interface ConnectionGenerationSource {
  generation?: {
    getSnapshot(): unknown
    subscribe(listener: () => void): () => void
  }
}

/**
 * Provide the client service; auto-connect once the host generation is ready.
 * @param ctx - client plugin context.
 * @param config - validated client configuration.
 */
export function apply(ctx: Context, config: CrossTransferClientConfig): void {
  // `CrossTransferClient extends Service`, so its constructor already registers
  // `crossTransferClient` — calling ctx.reflect.provide again is a duplicate.
  const client = new CrossTransferClient(ctx, config)

  // The sidebar foot is the visible entry point: a compact trigger that opens
  // the transfer UI in a floating panel. Registering before the auto-connect
  // early return keeps the entry present when auto-connect is off.
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'cross-transfer-panel',
        order: 100,
        inject: () => ({ client })
      },
      CrossTransferLauncher
    )
  )

  if (config.autoConnect === false) {
    ctx.logger.info('[cross-transfer] client mounted (auto-connect off)')
    return
  }

  const connection = (ctx as Context & { connection?: ConnectionGenerationSource }).connection
  const mount = () => {
    if (typeof window === 'undefined') return
    const origin = window.location.origin
    const wsUrl = `${origin.replace(/^http/, 'ws')}/api/cross-transfer`

    // The host generates a per-boot token secret, so an unauthenticated upgrade
    // is closed with 4001. Trade the device id for a token first; only a failure
    // to reach the token endpoint falls back to connecting without one.
    void (async () => {
      try {
        await client.fetchToken(`${origin}/api/cross-transfer/token`)
        await client.connect(wsUrl, client.getToken())
      } catch (error) {
        ctx.logger.warn('[cross-transfer] Auto-connect failed:', error)
      }
    })()
  }

  // The connection service owns generation readiness; without it, connect now.
  const generation = connection?.generation
  if (generation && typeof generation.subscribe === 'function') {
    if (generation.getSnapshot() !== undefined) {
      mount()
    } else {
      const unsubscribe = generation.subscribe(() => {
        if (generation.getSnapshot() !== undefined) {
          unsubscribe()
          mount()
        }
      })
    }
  } else {
    mount()
  }

  ctx.logger.info('[cross-transfer] client mounted')
}

export { CrossTransferClient } from './CrossTransferClient.js'
export { FileTransferPanel } from './FileTransferPanel.js'
export { ChatPanel } from './ChatPanel.js'
export { RoomPanel } from './RoomPanel.js'
export { GitSyncPanel } from './GitSyncPanel.js'
export { DeviceList } from './DeviceList.js'
export { CrossTransferUI } from './CrossTransferUI.js'

export default { name, inject, Config, apply }
