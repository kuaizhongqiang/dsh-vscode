import * as vscode from 'vscode'

const SERVER_URL = 'dsh.serverUrl'
const AUTO_CONNECT = 'dsh.autoConnect'
const AUTO_ATTACH_WORKSPACE = 'dsh.autoAttachWorkspace'
const DEFAULT_AGENT_PRESET = 'dsh.defaultAgentPreset'
const HISTORY_PAGE_SIZE = 'dsh.historyPageSize'
const RECONNECT_INTERVAL = 'dsh.reconnectIntervalMs'
const AUTO_OPEN_CHAT = 'dsh.autoOpenChat'
const SHOW_REASONING = 'dsh.showReasoning'
const MAX_TOOL_RESULT_CHARS = 'dsh.maxToolResultChars'
const EXTRA_HEADERS = 'dsh.extraHeaders'
const REMOTE = 'dsh.remote'
const CLOUDFLARE_COOKIE = 'dsh.cloudflareCookie'
const LOCAL_SERVER_PATH = 'dsh.localServerPath'
const PROMPT_MODE = 'dsh.promptMode'

export type PromptMode = 'steer' | 'queue'

export interface DshConfig {
  serverUrl: string
  autoConnect: boolean
  autoAttachWorkspace: boolean
  defaultAgentPreset: string
  historyPageSize: number
  reconnectIntervalMs: number
  autoOpenChat: boolean
  showReasoning: boolean
  maxToolResultChars: number
  /** 附加到每个 /api 请求与 mux WebSocket 握手头的自定义请求头（如 Cloudflare Access 认证）。 */
  extraHeaders: Record<string, string>
  /** Remote 模式开关：true = 直连远程 DSH（配 Cloudflare cookie 认证），false = 本地模式（可拉起本地 dsh web）。 */
  remote: boolean
  /** Remote 模式下 Cloudflare Access 的 `CF_Authorization` cookie 值，自动映射到请求头 `Cookie: CF_Authorization=…`。 */
  cloudflareCookie: string
  /** Local 模式下 dsh 安装/启动目录；配置后扩展可自动拉起 `dsh web`（cwd=该路径）并连接。 */
  localServerPath: string
  /** 发送消息的模式：'steer' = 插话（立即处理，默认，与 DSH Web 一致），'queue' = 排队（等当前回合结束）。 */
  promptMode: PromptMode
}

function key(full: string): string {
  return full.replace('dsh.', '')
}

export function readConfig(): DshConfig {
  const config = vscode.workspace.getConfiguration('dsh')
  const cloudflareCookie = config.get<string>(key(CLOUDFLARE_COOKIE), '')
  return {
    serverUrl: config.get<string>(key(SERVER_URL), 'http://127.0.0.1:3080'),
    autoConnect: config.get<boolean>(key(AUTO_CONNECT), true),
    autoAttachWorkspace: config.get<boolean>(key(AUTO_ATTACH_WORKSPACE), true),
    defaultAgentPreset: config.get<string>(key(DEFAULT_AGENT_PRESET), 'standard'),
    historyPageSize: config.get<number>(key(HISTORY_PAGE_SIZE), 40),
    reconnectIntervalMs: config.get<number>(key(RECONNECT_INTERVAL), 3000),
    autoOpenChat: config.get<boolean>(key(AUTO_OPEN_CHAT), true),
    showReasoning: config.get<boolean>(key(SHOW_REASONING), true),
    maxToolResultChars: config.get<number>(key(MAX_TOOL_RESULT_CHARS), 4000),
    extraHeaders: readExtraHeaders(config, cloudflareCookie),
    remote: config.get<boolean>(key(REMOTE), false),
    cloudflareCookie,
    localServerPath: config.get<string>(key(LOCAL_SERVER_PATH), ''),
    promptMode: readPromptMode(config),
  }
}

function readPromptMode(config: vscode.WorkspaceConfiguration): PromptMode {
  const value = config.get<string>(key(PROMPT_MODE), 'steer')
  return value === 'queue' ? 'queue' : 'steer'
}

function readExtraHeaders(config: vscode.WorkspaceConfiguration, cloudflareCookie: string): Record<string, string> {
  const raw = config.get<Record<string, string>>(key(EXTRA_HEADERS), {})
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0 && name.trim().length > 0) {
      out[name.trim()] = value
    }
  }
  // Remote 模式下的 Cloudflare Access cookie 自动映射为 Cookie 请求头。
  const cookie = cloudflareCookie.trim()
  if (cookie.length > 0) {
    const name = 'Cookie'
    const header = out[name]
    // 显式手写的 Cookie 头里如果没有 CF_Authorization，则注入；否则保留手写值。
    if (header === undefined || !header.includes('CF_Authorization=')) {
      out[name] = header === undefined || header.length === 0
        ? `CF_Authorization=${cookie}`
        : `${header}; CF_Authorization=${cookie}`
    }
  }
  return out
}

export function onConfigChanged(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('dsh')) listener()
  })
}

/** The DSH web GUI URL for a session (the same origin as the API). */
export function sessionWebUrl(serverUrl: string, sessionId: string): string {
  const base = serverUrl.replace(/\/+$/, '')
  return `${base}/session/${encodeURIComponent(sessionId)}`
}
