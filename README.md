# dsh-vscode

[![Open VSX 版本](https://img.shields.io/open-vsx/v/kuaizhongqiang/dsh-vscode?label=Open%20VSX)](https://open-vsx.org/extension/kuaizhongqiang/dsh-vscode)
[![Open VSX 下载](https://img.shields.io/open-vsx/dt/kuaizhongqiang/dsh-vscode)](https://open-vsx.org/extension/kuaizhongqiang/dsh-vscode)
[![GitHub Release](https://img.shields.io/github/v/release/kuaizhongqiang/dsh-vscode)](https://github.com/kuaizhongqiang/dsh-vscode/releases)

在 VSCode 中连接 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) 实例的扩展：
会话列表、流式聊天、工具调用卡片、审批与提问处理，无需打开浏览器。

**安装**：[Open VSX 扩展页](https://open-vsx.org/extension/kuaizhongqiang/dsh-vscode) 或 [GitHub Releases](https://github.com/kuaizhongqiang/dsh-vscode/releases) 下载 VSIX。

## 功能

- **连接管理**：本地 / 远程双模式，状态栏实时显示连接状态；事件流断线自动重连。
  - **本地模式**（默认）：配置 `dsh.localServerPath` 后自动拉起 `dsh web` 并连接（若 3080 端口已有 DSH 实例在运行则直接复用，不重复拉起）；也可直接连默认 `http://127.0.0.1:3080`。
  - **远程模式**：开启 `dsh.remote` 并填入 Cloudflare cookie（`dsh.cloudflareCookie`），自动作为认证头发送，改配置自动重连。
- **侧边栏入口式首页**（会话 / 拉起服务 / 进入配置 / 插件库 / 模式列表）：
  - 首页高亮当前工作区路径，显示连接状态与各入口概览，可进入子视图并返回；
  - **会话列表**：默认只显示当前工作区的会话（可切换查看全部），运行中 / 轮次 / 更新时间一目了然；支持新建、重命名、停止、在浏览器打开；
  - **拉起服务**：本地服务一键启动 / 停止，显示状态、端口、日志摘要与失败原因；
  - **进入配置**：设置页（连接模式开关、Cloudflare cookie、本地服务路径、服务地址、行为与数值项），改动即保存生效，断开连接时也可访问；
  - **插件库**：浏览已安装（`DSH_HOME` 下的 skills / tools / presets）与可用（dsh-plugins 合集仓库）插件，点击打开目录；
  - **模式列表**：浏览 agent preset，单击设为新建会话默认。
- **聊天面板**（Webview）：
  - 历史消息加载 + 实时流式输出（文本 / 思考过程分开展示，带打字光标）；用户 / 助手消息左右分栏带头像
  - **模型选择器**：面板头部直接切换会话使用的模型（provider/model）
  - 工具调用卡片：参数、执行状态（等待 / 执行中 / 完成 / 出错）、耗时、结果分区展示，可折叠
  - **审批卡片**：工具请求执行时直接在面板「允许一次 / 拒绝」
  - **提问表单**：Agent 提问时以选项 / 多选 / 自由文本作答
  - **斜杠命令**：输入 `/` 弹出命令候选（停止当前回合 / 清空显示 / 浏览器打开 / 帮助）
  - **`@` 文件提及**：输入 `@` 列出会话目录下的文件 / 文件夹，选中后以 `@路径` 引用
  - **文件拖入 / 粘贴**：把文件拖进输入区生成附件 chip，发送时以 `@文件名` 引用；**粘贴 / 拖入图片**（png/jpeg/webp/gif）直接作为附件发送（模型需支持图片输入）；**粘贴音频**保存到会话目录 `.dsh-paste/` 并以 `@路径` 引用
  - 停止当前回合（输入区与发送并排）、一键在浏览器打开同一会话、底部用量统计条
- **新建会话引导**：有多个 agent preset / 工作区时弹出选择，新会话可用不同 preset 与目录
- **工作区自动关联**：打开文件夹时自动在 DSH 创建 / 关联同名工作区（路径规范化比较，Windows 大小写 / junction 不重复创建，多根工作区全部关联），新会话默认在该目录工作。
- 会话标题 / 运行状态通过 mux 投影实时同步；官方 DSH 鲸鱼 logo 用于活动栏与市场图标。

## 要求

- VSCode ≥ 1.90（Node ≥ 20）
- 一个可访问的 DSH 实例（`dsh web` 已启动）。默认连接 `http://127.0.0.1:3080`。
- 远程访问时，DSH 需用 `--trusted-host <你的域名>` 启动（`/api` 信任围栏），否则 /api 会返回 403。
- 如果远程域名在 **Cloudflare Access**（Zero Trust）等访问控制后面，`/api` 请求会被 302 重定向到登录页，需要配置认证（见下文）。

### 远程访问（Cloudflare Access 等访问控制）

DSH 的 Web 端能访问是因为浏览器持有 `CF_Authorization` 会话 cookie，而扩展是无 cookie 的机器客户端。

**推荐方式：远程模式 + Cloudflare cookie（设置页一键配置）**
1. 设置页（侧边栏「进入配置」）或设置 JSON 中开启 `dsh.remote`（远程模式）。
2. 在浏览器登录 `https://dsh.your-domain`，DevTools → Application → Cookies 里复制 `CF_Authorization` 的值。
3. 填入 `dsh.cloudflareCookie`（设置页的「Cloudflare Cookie」字段），扩展自动作为 `Cookie: CF_Authorization=…` 请求头发送（/api 与事件流均带），改配置后自动重连。

**方式 B：服务令牌（无需 cookie）**
1. Cloudflare Zero Trust → Access → Service Auth → 创建 Service Token，得到 Client ID 与 Client Secret。
2. Access → Applications → dsh 应用 → 策略中把该 Service Token 加入允许身份。
3. 扩展设置：
   ```json
   "dsh.extraHeaders": {
     "CF-Access-Client-Id": "<你的 Client ID>",
     "CF-Access-Client-Secret": "<你的 Client Secret>"
   }
   ```

### 本地服务路径（dsh.localServerPath）

`dsh.localServerPath` 是**本地模式下 dsh 的安装 / 启动目录**，即运行 `dsh web` 时所在的目录，
**应包含 dsh 启动器**（`dsh.cmd` / `dsh` / `dsh.exe` / `dsh-launcher.exe` / `launcher.json`）。

- 样例：
  - Windows：`D:\dsh`（`dsh.cmd` / `dsh.exe` / `dsh-launcher.exe` 所在目录，即 dsh 安装根目录）
  - macOS / Linux：`~/dsh`（`dsh` 可执行文件所在目录）
- 配置时会校验：路径存在、是目录、含 dsh 启动器；不满足时给出明确错误提示，不会写入。
- 配置后 VSCode 启动（或点击连接 / 侧边栏「拉起服务 → 启动服务」）会自动 `spawn dsh web`（cwd=该目录）、
  轮询就绪后连接；扩展退出时自动终止服务进程（Windows 下杀进程树），不残留孤儿进程。
- 端口占用处理：`dsh web` 固定监听 3080。若 3080 上**已有 DSH 实例**在运行（例如已有一个 `dsh web`），
  「拉起服务」会**直接复用**该实例（幂等，不重复拉起、不报端口冲突）；若 3080 被**非 DSH 进程**占用，
  会明确报错提示先释放端口，不会盲目拉起导致 EADDRINUSE 崩溃。

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
pnpm exec vsce package --no-dependencies
code --install-extension dsh-vscode-0.0.7.vsix
```

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.serverUrl` | `http://127.0.0.1:3080` | DSH 服务地址（本地模式可留空用默认，远程模式必填远程地址） |
| `dsh.remote` | `false` | 连接模式开关：`true` = 远程模式（配 Cloudflare cookie 认证），`false` = 本地模式（可拉起本地 `dsh web`） |
| `dsh.cloudflareCookie` | `""` | 远程模式下 Cloudflare Access 的 `CF_Authorization` cookie 值，非空时自动作为 `Cookie` 请求头发送 |
| `dsh.localServerPath` | `""` | 本地模式下 dsh 安装 / 启动目录（应包含 `dsh.cmd` / `dsh` 启动器）。样例：Windows `D:\dsh`，macOS/Linux `~/dsh` |
| `dsh.autoConnect` | `true` | 启动后自动连接（本地模式下若已配置 `localServerPath` 会自动拉起服务） |
| `dsh.autoAttachWorkspace` | `true` | 自动创建 / 关联当前文件夹为 DSH 工作区 |
| `dsh.defaultAgentPreset` | `standard` | 新建会话的 agent preset（不存在时回退到服务端默认） |
| `dsh.historyPageSize` | `40` | 打开会话时加载的 message 数量 |
| `dsh.reconnectIntervalMs` | `3000` | 事件流重连间隔 |
| `dsh.autoOpenChat` | `true` | 新建会话后自动打开聊天面板 |
| `dsh.showReasoning` | `true` | 是否显示模型的思考过程（reasoning）折叠块 |
| `dsh.maxToolResultChars` | `4000` | 工具调用结果在面板中的最大展示字符数 |
| `dsh.promptMode` | `steer` | 发送消息模式：`steer` = 插话（立即处理，与 DSH Web 一致），`queue` = 排队（等当前回合结束） |
| `dsh.extraHeaders` | `{}` | 附加到每个 `/api` 请求与事件流 WebSocket 握手头的自定义请求头（见「远程访问」） |

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
| `DSH: 打开设置` | 侧边栏切换到设置页（标题栏第 4 个按钮） | |
| `DSH: 返回首页` | 侧边栏返回入口式首页 | |
| `DSH: 切换侧边栏视图` | 内部导航命令（会话 / 服务 / 设置 / 插件 / 模式） | |
| `DSH: 打开设置页` | 「拉起服务」页内跳转到设置页 | |
| `DSH: 切换会话范围` | 会话列表「只看当前工作区 ⇄ 查看全部」 | |
| `DSH: 编辑设置项` | 设置页点击某项后编辑（开关翻转 / 输入框 / 目录选择） | |
| `DSH: 设为默认 preset` | 模式列表中单击 preset 设为新建会话默认 | |
| `DSH: 打开设置 JSON` | 打开 VSCode 设置 UI 并定位到 dsh 项 | |
| `DSH: 打开 DSH_HOME 目录` | 在资源管理器中显示 DSH 数据目录 | |
| `DSH: 打开插件路径` | 插件库中点击插件打开其目录 / 文件 | |
| `DSH: 启动本地服务` | 拉起本地 `dsh web`（需已配置 `dsh.localServerPath`） | |
| `DSH: 停止本地服务` | 停止本地 `dsh web` 服务进程 | |

## 架构

```
src/
├── extension.ts         激活入口：连接生命周期、命令、工作区自动关联、设置与本地服务编排
├── config.ts            设置读写（含 remote / cloudflareCookie / localServerPath 与 Cookie 头注入）
├── statusBar.ts         状态栏
├── sidebar.ts           侧边栏入口式首页 + 会话 / 服务 / 设置 / 插件 / 模式多视图导航
├── sessionStore.ts      会话/工作区缓存（session.list + mux/host 帧增量）
├── localServer.ts       本地 dsh web 服务生命周期（spawn / 就绪轮询 / 终止，路径校验）
├── plugins.ts           插件库数据源（DSH_HOME 已安装 + dsh-plugins 合集仓库可用）
├── client/
│   ├── types.ts         DSH 线上协议类型（对齐 @deepseek-ai/dsh-host-apiproxy）
│   ├── rpc.ts           /api 单发 RPC 客户端（client-request / server-response 信封）
│   ├── mux.ts           /api/events.mux WebSocket 客户端（自动重连）
│   └── connection.ts    高层封装：session/workspace 操作、审批/提问应答、事件分发
└── chat/
    ├── types.ts         渲染模型 + webview 双向消息协议（含 @ 文件候选）
    ├── chatModel.ts     会话消息模型（历史 + 流式，seq 去重）
    └── chatPanel.ts     Webview 面板控制器（含 @ 提及目录扫描）
media/webview.html       聊天 UI（零依赖，内联 CSS/JS：斜杠命令 / @ 提及 / 拖入 / 视觉主题）
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
pnpm test        # vitest 单元测试
node scripts/check-webview-js.mjs   # webview 内联 JS 语法校验
```

## 已知限制（v0.0.7）

- 历史分页「加载更多」尚未实现（仅加载最近一页）。
- 图片消息暂不展示字节（文本 / 推理 / 工具已支持；粘贴 / 拖入图片会作为附件以 `image` block 发送给模型，历史回显仅显示 `[图片]` 占位）。
- 事件流为单向推送；无断点续传，重连后靠 seq 去重收敛。
- `@` 文件提及扫描的是会话 cwd 的一级目录（不递归）；拖入普通文件以 `@文件名` 文本引用（webview 拿不到完整路径）。

## CI 与发布

- `.github/workflows/ci.yml`：push/PR 时执行 typecheck、单元测试（vitest）、构建、webview JS 校验并打包 VSIX 产物。
- `.github/workflows/release.yml`：推送 `v*` tag 时自动构建并发布 GitHub Release（附 VSIX）。可选往
  [Open VSX](https://open-vsx.org) 发布：在仓库 Secrets 中配置 `OPEN_VSX_TOKEN` 后自动生效。

```bash
git tag v0.0.7 && git push origin v0.0.7   # 触发发布流水线
```

## License

MIT
