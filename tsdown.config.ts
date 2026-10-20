import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    // Host half: plain ESM, loaded by the dsh profile's cordis loader.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node20',
    dts: true,
    clean: true,
    sourcemap: false,
    outDir: 'lib',
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-host-webserver',
      '@deepseek-ai/schemastery',
      'ws',
      'isomorphic-git'
    ]
  },
  {
    // Browser half: the harness's client module system loads each bundle as
    // `window.__ModuleLoader__.load({ id, factory })` with a CommonJS-style
    // `require`, so this half is built as CJS and wrapped by
    // scripts/wrap-client.mjs afterwards (see the `bundle` script).
    entry: { index: 'src/client/index.tsx' },
    format: ['cjs'],
    platform: 'browser',
    // esnext: the module system provides no runtime-helper module, so the bundle
    // must carry its own helpers rather than require("@oxc-project/runtime/...").
    target: 'esnext',
    dts: true,
    clean: false,
    sourcemap: false,
    outDir: 'lib/client',
    external: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-connection',
      'react',
      'react-dom',
      'react/jsx-runtime',
      'zod'
    ]
  }
])
