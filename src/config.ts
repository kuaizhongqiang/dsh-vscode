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
}

function key(full: string): string {
  return full.replace('dsh.', '')
}

export function readConfig(): DshConfig {
  const config = vscode.workspace.getConfiguration('dsh')
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
    extraHeaders: readExtraHeaders(config),
  }
}

function readExtraHeaders(config: vscode.WorkspaceConfiguration): Record<string, string> {
  const raw = config.get<Record<string, string>>(key(EXTRA_HEADERS), {})
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.length > 0 && name.trim().length > 0) {
      out[name.trim()] = value
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
