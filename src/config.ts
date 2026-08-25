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
  }
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
