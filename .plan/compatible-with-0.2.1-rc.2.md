# 迁移到 dsh 0.2.1-rc.2：代码结构与开发进度

> 本文档是本次编码的真源：确定后直接照着它编码；节点编号在编码期间保持不变（提交信息用它指明完成到哪）。
> 状态：`- [ ]` 未完成 / `- [x]` 已完成。一个最小节点完成 = 其下全部要点已勾选，且「完成判据」成立。
> 生成：2026-10-20，由 `plugin-compatible-check` 全量检查产出；证据见对话报告与 `/tmp/dsh-cross-transfer-compat/{host-audit,client-audit,upstream-notes}.md`。
> 分支：`compat/dsh-0.2.1-rc.2-check`（自 `master` 新建；不提交、不 push，改动留待审阅）。

## 1 需求与范围

**需求**：把 `dsh-cross-transfer` 从记录版本 `0.1.2-rc.2` 迁移到当前安装的 dsh `0.2.1-rc.2`：
1. 修复唯一硬阻断——包清单里过期的 `dsh-host-webserver` peer 范围（0.2.1-rc.2 兼容门禁会拒装/禁用整个插件）；
2. 按用户确认，一并完成检查中列出的可选清理：devDeps 对齐、清理 `dsh.client.inject`、修正 client 类型出口、client bundle 外置 zod、面板硬编码颜色改为 theme token；
3. 适配客户端 bundle URL 契约变化，修复仓库自带的 boot 验证脚本。

**不做的事**：

- 不改 `src/**` 业务逻辑/接口/数据流（Host/Client 实现经真机验证与当前 dsh 兼容）；本次只改 UI 内联颜色。
- 不保留对 `0.1.2-rc.1` 的兼容（不加双版本分支、不写 fallback）。
- **不升 `@types/react` 到 19**：实测升 19 后 `ctx.slots.register` 的组件类型报错（React 19 types 的 async component `Promise<ReactNode>` 与 slots 包的 `SlotComponent` 不匹配）；当前 dsh 官方 client 包 devDeps 全部按 `react ^18.2.0` 编译，仓库保持 `^18.3.0` 才与其实例一致。
- 不发布 npm、不改 README、不改 `dsh` 字段结构（仅删除 `dsh.client.inject`）。
- 不创建/更新 `COMPATIBLE_VERSION`（用户决定：执行完本计划并验证通过后再写入 `0.2.1-rc.2` 与当日日期）。
- 不动 `dependencies`（schemastery/isomorphic-git/ws）、`scripts`、`files` 中除 client 类型文件外的条目。

**关键假设**：

- 用户所说基线 `0.1.2-rc.2` 在上游从未发布（GitHub tag/release、npm 均无；仓库 `package-lock.json` 全部为 `0.1.2-rc.1`）。实际起点是 **`0.1.2-rc.1`（2026-09-03）**，本计划以它为旧版本侧。
- 当前运行环境：`dsh` 为 `0.2.1-rc.2`，安装目录 `$D=/home/axkj/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh`；其中 `@deepseek-ai/cordis` 4.0.5、`schemastery` 3.18.5、各 `@deepseek-ai/dsh-*` 均为 `0.2.1-rc.2`；Web shell 内置 React 19.7.1 与 `zod`（含 `prefault`/`~standard`，v4 语义）。
- 0.2.1-rc.2 兼容门禁规则（`$D/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` 的 `unmetRequirements`/`evaluatePluginCompatibility`）：manifest 无 `engines.dsh` 时，逐个检查 `peerDependencies` 中以 `@deepseek-ai/dsh` 开头的包是否满足运行时版本（`semver.satisfies(..., {includePrerelease:true})`）。`@deepseek-ai/cordis` 不参与该门禁。
- 客户端 boot graph 的 bundle URL 在 0.2.1-rc.2 由绝对 `/plugins/...` 改为文档相对 `plugins/...`（`dsh-client-modules` 0.2.1-rc.2 的 `comboReference` = 0.1.2-rc.1 的 `comboUrl(...).slice(1)`）。
- `dsh.client.inject` 只是工厂到达/组合的"包名依赖边"，不是 Cordis service 注入；当前 shell 对未知项静默跳过（`dsh-client-modules/lib/client.js` 的 `arriveGraphRow`）。本插件 client bundle 实际只 require `@deepseek-ai/cordis`、`react`、`react/jsx-runtime`，三者均为 shell 静态 seed。
- 用户机器为 WSL：临时 profile 放在 `$HOME` 文件系统下才能复用已有 pnpm store（放 `/tmp` 会触发 pnpm store 不匹配）。

## 2 代码结构

```text
dsh-cross-transfer/
├── package.json                     # 修改：peer/dev 依赖、删除 dsh.client.inject、client 类型出口
├── package-lock.json                # 修改：npm install 重生成
├── tsdown.config.ts                 # 修改：client 段 externals 增加 zod
├── scripts/
│   └── verify-boot-graph.mjs        # 修改：适配 /plugins/ → plugins/ 的 client bundle URL
└── src/client/                      # 修改（仅内联颜色）：改为 --dsw-* token
    ├── ChatPanel.tsx                # 19 处硬编码颜色
    ├── CrossTransferLauncher.tsx    # 4 处
    ├── CrossTransferUI.tsx          # 13 处
    ├── DeviceList.tsx               # 14 处
    ├── FileTransferPanel.tsx        # 24 处
    ├── GitSyncPanel.tsx             # 28 处
    └── RoomPanel.tsx                # 54 处
```

| 文件 | 新增/修改 | 职责 |
| --- | --- | --- |
| `package.json` | 修改 | peer 范围过门禁；devDeps 对齐当前类型；删 `dsh.client.inject`；`exports["./client"].types` 指向实际产物 |
| `package-lock.json` | 修改 | 与 package.json 一致（`npm install` 生成，勿手改） |
| `tsdown.config.ts` | 修改 | client 段把 `zod` 加入 external，改用 shell seed 的 zod |
| `scripts/verify-boot-graph.mjs` | 修改 | 修正 boot graph 行 URL 正则，使脚本能取到并校验 client bundle |
| `src/client/*.tsx`（7 个） | 修改 | 仅把内联样式里的硬编码颜色换成 `var(--dsw-*)`；组件结构/逻辑不动 |

**关键接口与数据流**：`dsh plugin add` / profile 装载 → `dsh-app-boot` 读插件 `package.json` 的 `peerDependencies`（无 `engines.dsh`）→ 门禁放行后读 `dsh.bundle.patch` 合并 `cordis.patch.yml` → Host Loader 挂载 `dsh-cross-transfer` 行 → `dsh-client-modules` 扫描该包 `dsh.client` 生成 boot graph 行（`url: "plugins/??dsh-cross-transfer/client.js&rev=..."`）→ 服务端注入 index → 浏览器 `window.__ModuleLoader__.load(...)` 注册并物化 client bundle（require 表：cordis/react/jsx-runtime/zod，全部 seed）。`scripts/verify-boot-graph.mjs` 在最后一步之前抓 index，用正则从 HTML 里取该行与 bundle 地址。

**冻结的签名 / 数据**：

- theme token 映射表（UI 改色唯一依据，见 §3.4.1；7 个文件并行修改时不得自创 token）。
- 其余为单文件顺序改动，无并行接口需要冻结。

## 3 开发进度

### 3.1 通过 0.2.1-rc.2 的插件兼容门禁（必改，1 项硬阻断）

#### 3.1.1 更新 `package.json` 的 `peerDependencies`

- [ ] `@deepseek-ai/cordis`：`^4.0.2` → `~4.0.5`。
- [ ] `@deepseek-ai/dsh-host-webserver`：`^0.1.2-rc.1` → `^0.2.1-rc.2`。
- [ ] 不动 `dependencies`、`dsh` 字段（本节点只改 peer）。
- 完成判据：`grep -n '0\.1\.2-rc' package.json` 无输出（旧版本号全部清除）。

#### 3.1.2 重生成 lock 并跑兼容门禁评测

- [ ] `npm install`（更新 `package-lock.json`；确认 `node_modules/@deepseek-ai/*` 为 0.2.1-rc.2、cordis 为 4.0.5）。
- [ ] 用当前 dsh 的门禁评测函数对改后的 manifest 求值（必须放行）：
  ```bash
  D="$(dirname "$(dirname "$(readlink -f "$(command -v dsh)")")")"
  node --input-type=module -e "
  import { readFileSync } from 'node:fs'
  import { evaluatePluginCompatibility } from 'file://$D/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'
  const issue = evaluatePluginCompatibility(JSON.parse(readFileSync('package.json','utf8')))
  console.log(issue === undefined ? 'PASS' : 'FAIL ' + JSON.stringify(issue))
  "
  ```
- 完成判据：命令输出 `PASS`（当前基线实测：改前为 FAIL，requirements 为 `{"@deepseek-ai/dsh-host-webserver":"^0.1.2-rc.1"}`）。

### 3.2 依赖与清单清理（可选，用户已接受）

#### 3.2.1 devDependencies 对齐 0.2.1-rc.2

- [ ] `@deepseek-ai/cordis` → `~4.0.5`。
- [ ] `@deepseek-ai/dsh-client-connection`、`dsh-client-ui-renderer`、`dsh-client-ui-sidebar`、`dsh-client-ui-slots`、`dsh-host-webserver`、`dsh-typert-protocol`、`dsh-util-crypto` → `^0.2.1-rc.2`。
- [ ] 新增 `@deepseek-ai/dsh-client-store` → `^0.2.1-rc.2`（`dsh-client-ui-slots` 的类型声明 import 它，显式声明后 typecheck 才不依赖 `skipLibCheck` 掩盖）。
- [ ] `npm install` 重生成 lock。
- 完成判据：`node -e "for (const p of ['cordis','dsh-client-ui-renderer','dsh-client-ui-sidebar','dsh-client-connection','dsh-client-ui-slots','dsh-host-webserver','dsh-client-store']) console.log(p, require('@deepseek-ai/'+p+'/package.json').version)"` 输出为 4.0.5 / 0.2.1-rc.2，且 `npm run typecheck` 0 error。

#### 3.2.2 清理过期的 `dsh.client.inject`

- [ ] 删除 `package.json` 的 `dsh.client.inject` 整个字段（保留 `platform: "web"`、`immediately: true`）。
- [ ] 不改 `cordis.patch.yml`。
- 完成判据：`node -e "console.log(JSON.stringify(require('./package.json').dsh.client))"` 输出不含 `inject`；`npm run bundle` 后临时 host 的 boot graph 行不再带 `inject` 字段且启动无警告（见 3.6.2）。

#### 3.2.3 修正 client 类型出口

- [ ] `exports["./client"].types`：`./lib/client/index.d.ts` → `./lib/client/index.d.cts`（tsdown 的 CJS dts 实际产物）。
- [ ] `files` 数组里 `lib/client/index.d.ts` → `lib/client/index.d.cts`。
- 完成判据：`npm run bundle` 后 `ls lib/client/index.d.cts` 存在；`npm pack --dry-run` 列表包含 `lib/client/index.d.cts`；`node -e "console.log(require('./package.json').exports['./client'].types)"` 指向存在的文件。

### 3.3 client 构建（可选，用户已接受）

#### 3.3.1 client bundle 外置 zod（改用 shell seed）

- [ ] `tsdown.config.ts` 第二个 config（client 段）的 `external` 数组追加 `'zod'`。
- [ ] `npm run bundle`。
- 完成判据：`grep -c 'require("zod")' lib/client/index.js` 为 1；bundle 体积由 299,544 B 降到约 130 KB（本次实测 129,838 B，require 恰为 `[@deepseek-ai/cordis, react, react/jsx-runtime, zod]` 四条）；离线探针以这四个 seed 作 require 表执行 factory 成功、`Config['~standard'].validate(undefined)` 仍得 `{autoConnect:true}`；3.6.2 的临时 host boot graph/client bundle/REST 仍全通过。

### 3.4 面板主题 token 化（可选，用户已接受）

#### 3.4.1 把 `src/client/*.tsx` 中的硬编码颜色替换为 `--dsw-*` token

统一按下方**冻结映射表**替换；颜色作为 `var(--dsw-*, <原值>)` 的 fallback 保留时，原值只允许出现在 `var()` 内。共 156 处、7 个文件，按文件分 5 个 Agent 并行，写入范围互不重叠：

- [ ] **Agent A**：`src/client/ChatPanel.tsx`（19 处）+ `src/client/CrossTransferLauncher.tsx`（4 处）— 产出：文件内不再有裸 hex（依赖：§2 冻结映射表）
- [ ] **Agent B**：`src/client/CrossTransferUI.tsx`（13 处）+ `src/client/DeviceList.tsx`（14 处）— 同上（依赖：§2 冻结映射表）
- [ ] **Agent C**：`src/client/FileTransferPanel.tsx`（24 处）— 同上（依赖：§2 冻结映射表）
- [ ] **Agent D**：`src/client/GitSyncPanel.tsx`（28 处）— 同上（依赖：§2 冻结映射表）
- [ ] **Agent E**：`src/client/RoomPanel.tsx`（54 处）— 同上（依赖：§2 冻结映射表）
- 完成判据：`grep -rn '#[0-9a-fA-F]\{3,8\}' src/client/*.tsx | grep -v 'var(--dsw-'` 无输出；`npm run typecheck` 0 error；用户浏览器 light/dark 各看一遍面板可读、无颜色明显错乱。

**冻结映射表**（新代码只用右侧 token；现有代码里已有的 4 处 token（含 fallback）保持不动）：

| 原硬编码 | 语义 | 替换 |
| --- | --- | --- |
| `#fff`（作背景） | 面板/卡片/输入框底 | `var(--dsw-alias-bg-layer-1)` |
| `#fff`（作主色底上的文字） | 反色文字 | `var(--dsw-alias-label-primary-inverted)` |
| `#fafafa` | 次级/表头底 | `var(--dsw-alias-bg-layer-2)` |
| `#f0f0f0` | 次级填充、进度槽、能力标签底 | `var(--dsw-alias-bg-layer-2)` |
| `#f8f9fa` | hover 底 | `var(--dsw-alias-interactive-bg-hover)` |
| `#f8f9fa` | 代码/日志块底 | `var(--dsw-alias-bg-layer-2)` |
| `#eee`（作边框） | 细分隔线 | `var(--dsw-alias-border-l1)` |
| `#eee`（作进度槽） | 槽底 | `var(--dsw-alias-bg-layer-2)` |
| `#ddd` | 边框 | `var(--dsw-alias-border-l2)` |
| `#333` | 主文字 | `var(--dsw-alias-label-primary)` |
| `#666` | 次文字 | `var(--dsw-alias-label-secondary)` |
| `#999` | 三级文字 | `var(--dsw-alias-label-tertiary)` |
| `#ccc` | 弱化文字/占位 | `var(--dsw-alias-label-caption)` |
| `#6c757d` | 中性失效态 | `var(--dsw-alias-label-secondary)` |
| `#007bff`（作按钮底） | 主按钮底 | `var(--dsw-alias-button-primary-fill)` |
| `#007bff`（作文字/边框/下划线） | 品牌/激活强调 | `var(--dsw-alias-state-business-primary)` |
| `#28a745` | 成功点/成功按钮底 | `var(--dsw-alias-state-success-primary)` |
| `#dc3545` | 错误点/危险按钮底 | `var(--dsw-alias-state-error-primary)` |
| `#d4edda` / `#c3e6cb` | 成功提示底 / 边 | `var(--dsw-alias-state-success-tertiary)` / `var(--dsw-alias-state-success-secondary)` |
| `#155724` | 成功提示文字 | `var(--dsw-alias-label-primary)` |
| `#f8d7da` / `#f5c6cb` | 错误提示底 / 边 | `var(--dsw-alias-interactive-bg-hover-danger)` / `var(--dsw-alias-state-error-secondary)` |
| `#721c24` | 错误提示文字 | `var(--dsw-alias-state-error-primary)` |
| `#fff3cd` / `#ffeeba` | 警告提示底 / 边 | `var(--dsw-alias-state-warn-tertiary)` / `var(--dsw-alias-state-warn-secondary)` |
| `#856404` | 警告提示文字 | `var(--dsw-alias-state-warn-label)` |
| `#e7f3ff` / `#b6d7ff` | 选中项底 / 边 | `var(--dsw-alias-state-business-tertiary)` / `var(--dsw-alias-state-business-primary)` |
| `#cce5ff` / `#004085` | 信息提示底 / 文字 | `var(--dsw-alias-state-business-tertiary)` / `var(--dsw-alias-state-business-primary)` |

### 3.5 仓库验证脚本适配（必改）

#### 3.5.1 修正 `scripts/verify-boot-graph.mjs` 的 graph 行 URL 正则

- [ ] 第 77 行 combo 正则去掉前导 `/`，匹配文档相对地址：
  ```js
  const combo = new RegExp(`plugins/\\?\\?${escape(pluginId)}/client\\.js[^"'&]*&rev=[^"&]*`, 'u').exec(html)?.[0] ?? null
  ```
- [ ] 其余保持不动：`graphRow` 正则、marker 检查、`/api/cross-transfer/rooms` 探测、默认参数与退出判据。
- 完成判据：在装有本插件的临时 profile 上运行脚本退出码 0，输出 `inBootGraph: true` 且 `bundleHasMarker: true`（见 3.6.2；真实 profile 不要改）。

### 3.6 整机回归验证

#### 3.6.1 typecheck + 全量测试

- [ ] `npm run typecheck` → 0 error。
- [ ] `npm test` → 10 个测试文件、343 个用例全通过（本次检查已在 0.2.1-rc.2 依赖下实测的基线）。
- 完成判据：两条命令均通过。

#### 3.6.2 临时 profile 安装 + 服务端/客户端加载实测

- [ ] `npm run bundle && npm pack`。
- [ ] 在 `$HOME` 下的临时 DSH_HOME 复制 `~/.dsh/profiles/web`（不要改真实 profile），`dsh plugin --profile web add ./dsh-cross-transfer-0.1.0.tgz`，确认安装成功、插件进入 `dsh.profile.bundles`。
- [ ] `DSH_HOME=<临时> dsh web --port 0 --no-open`，确认：
  1. index 的 boot graph 含 `dsh-cross-transfer` 行（无 `inject` 字段、`immediately: true`），且 `node scripts/verify-boot-graph.mjs --profile <临时 profile> --dsh "$(readlink -f "$(command -v dsh)")"` 退出码 0；
  2. `GET /api/cross-transfer/rooms` 返回 200；
  3. `POST /api/cross-transfer/token` 返回 token，且用该 token 连 `ws://<host>/api/cross-transfer` 能收到 `welcome` 帧。
- 完成判据：以上三条全部成立（本次检查已用同一方法实测通过；验证完删除临时 DSH_HOME）。

## 4 验证基线（供执行时对照）

| 验证项 | 本次检查实测结果（当前 0.2.1-rc.2） |
| --- | --- |
| 兼容门禁（`evaluatePluginCompatibility`） | 旧 manifest → `FAIL`（`{"@deepseek-ai/dsh-host-webserver":"^0.1.2-rc.1"}`）；仅把 peer 改 `^0.2.1-rc.2` → `PASS` |
| 启动行为（旧 manifest） | 插件行被禁用：`dsh: disabling profile plugin row "cross-transfer": ... incompatible with dsh 0.2.1-rc.2`；boot graph 无该行；REST 401 |
| 启动行为（修 peer 后，临时 profile 真安装） | boot graph 行存在、client bundle 200/299,544 B 且含 `sidebar.footer.action`，`/api/cross-transfer/rooms` 200，WS upgrade 收到 `welcome` |
| `npm run typecheck`（当前依赖替换后） | 0 error |
| `npm test`（当前依赖替换后） | 343/343 通过 |
| `dsh web --dump-config` | 插件行与全部 rooms 默认值正确投影 |

> 收尾（验证通过后、由检查方执行）：把 `COMPATIBLE_VERSION` 第一行写 `0.2.1-rc.2`、第二行写验证当日日期（本次检查确认仓库当前无此文件）。
