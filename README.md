# dsh-vscode

在 VSCode 中连接 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 实例的扩展：
会话列表、流式聊天、工具调用卡片、审批与提问处理，无需打开浏览器。

## 功能

- **连接管理**：配置 DSH 服务地址（本地或远程），状态栏实时显示连接状态；事件流断线自动重连。
- **会话侧边栏**：按工作区（workspace）分组展示会话，运行中/轮次一目了然；支持新建、重命名、停止、在浏览器打开。
- **聊天面板**（Webview）：
  - 历史消息加载 + 实时流式输出（文本 / 思考过程分开展示，带打字光标）
  - 工具调用卡片：参数、执行状态、结果（错误标红），可折叠
  - **审批横幅**：工具请求执行时直接在面板「允许一次 / 拒绝」
  - **提问表单**：Agent 提问时以选项/多选/自由文本作答
  - 停止当前回合、一键在浏览器打开同一会话
- **工作区自动关联**：打开文件夹时自动在 DSH 创建/关联同名工作区，新会话默认在该目录工作。
- 会话标题 / 运行状态通过 mux 投影实时同步。

## 要求

- VSCode ≥ 1.90（Node ≥ 20）
- 一个可访问的 DSH 实例（`dsh web` 已启动）。默认连接 `http://127.0.0.1:3080`。
- 远程访问时，DSH 需用 `--trusted-host <你的域名>` 启动（`/api` 信任围栏），否则 /api 会返回 403。

## 安装

### 从源码构建（开发）

```bash
git clone https://github.com/kuaizhongqiang/dsh-vscode.git
cd dsh-vscode
pnpm install        # 或 npm install
pnpm build          # 产出 dist/extension.js
```

按 `F5` 打开扩展开发宿主（需要 `.vscode/launch.json`，已随仓库提供）。

### 打包 .vsix

```bash
pnpm exec vsce package
code --install-extension dsh-vscode-0.0.0.vsix
```

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.serverUrl` | `http://127.0.0.1:3080` | DSH 服务地址 |
| `dsh.autoConnect` | `true` | 启动后自动连接 |
| `dsh.autoAttachWorkspace` | `true` | 自动创建/关联当前文件夹为 DSH 工作区 |
| `dsh.defaultAgentPreset` | `standard` | 新建会话的 agent preset（不存在时回退到服务端默认） |
| `dsh.historyPageSize` | `40` | 打开会话时加载的 message 数量 |
| `dsh.reconnectIntervalMs` | `3000` | 事件流重连间隔 |

## 命令

| 命令 | 说明 | 快捷键 |
|---|---|---|
| `DSH: 连接` / `DSH: 断开连接` | 连接 / 断开 DSH 实例 | |
| `DSH: 打开聊天` | 打开选中会话的聊天面板（未选中则快速选择） | `Ctrl+Alt+D` |
| `DSH: 新建会话` | 在当前工作区新建会话并打开聊天 | |
| `DSH: 刷新会话列表` | 重新拉取 session.list + workspace.list | |
| `DSH: 在浏览器打开` | 在浏览器打开选中会话（DSH Web GUI） | |
| `DSH: 停止当前回合` | 取消选中会话正在进行的回合 | |
| `DSH: 重命名会话` | 重命名选中会话 | |

## 架构

```
src/
├── extension.ts         激活入口：连接生命周期、命令、工作区自动关联
├── config.ts            设置读写
├── statusBar.ts         状态栏
├── sidebar.ts           会话树（工作区 → 会话）
├── sessionStore.ts      会话/工作区缓存（session.list + mux/host 帧增量）
├── client/
│   ├── types.ts         DSH 线上协议类型（对齐 @deepseek-ai/dsh-host-apiproxy）
│   ├── rpc.ts           /api 单发 RPC 客户端（client-request / server-response 信封）
│   ├── mux.ts           /api/events.mux WebSocket 客户端（自动重连）
│   └── connection.ts    高层封装：session/workspace 操作、审批/提问应答、事件分发
└── chat/
    ├── types.ts         渲染模型 + webview 双向消息协议
    ├── chatModel.ts     会话消息模型（历史 + 流式，seq 去重）
    └── chatPanel.ts     Webview 面板控制器
media/webview.html       聊天 UI（零依赖，内联 CSS/JS）
```

### 协议要点（无需安装任何 DSH npm 包）

- 单发 RPC：`POST {base}/api/{method}`，body 为
  `{"type":"client-request","rpcId":"<uuid>","method":"…","payload":{…}}`，
  响应 `{"type":"server-response","rpcId":"…","result":{"ok":true,"value":…}|{"ok":false,"error":…}}`。
- 事件流：WebSocket `{base}/api/events.mux`，每条消息是 `server-request` 信封，payload 为 mux 帧
  （`session/event`、`session/projection`、`approval/requested`、`question/requested`、`session/jobs`…）。
- 审批 / 提问应答：`POST {base}/api/respond`，body 为 `client-response`，rpcId 回显帧的 rpcId。
- 会话事件：`user/message`、`assistant/chunk`（text-delta / reasoning-delta / tool-call-delta…）、
  `assistant/message`、`tool/call`、`tool/result`、`turn/end` 等。

## 测试

```bash
# 协议冒烟测试（只读：describe/list/history + mux 帧）
node --experimental-strip-types scripts/smoke.mts http://127.0.0.1:3080

# 端到端（会新建会话并发一条极小 prompt，验证 创建→prompt→流式→history）
node --experimental-strip-types scripts/e2e.mts http://127.0.0.1:3080

pnpm typecheck   # tsc --noEmit
pnpm build       # esbuild
```

## 已知限制（v0.1）

- 历史分页「加载更多」尚未实现（仅加载最近一页）。
- 图片消息暂不展示（文本/推理/工具已支持）。
- 事件流为单向推送；无断点续传，重连后靠 seq 去重收敛。

## CI 与发布

- `.github/workflows/ci.yml`：push/PR 时执行 typecheck、单元测试（vitest）、构建、webview JS 校验并打包 VSIX 产物。
- `.github/workflows/release.yml`：推送 `v*` tag 时自动构建并发布 GitHub Release（附 VSIX）。可选往
  [Open VSX](https://open-vsx.org) 发布：在仓库 Secrets 中配置 `OPEN_VSX_TOKEN` 后自动生效。

```bash
git tag v0.0.0 && git push origin v0.0.0   # 触发发布流水线
```

## License

MIT
