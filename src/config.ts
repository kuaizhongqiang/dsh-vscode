import * as vscode from 'vscode'

const SERVER_URL = 'dsh.serverUrl'
const AUTO_CONNECT = 'dsh.autoConnect'
const AUTO_ATTACH_WORKSPACE = 'dsh.autoAttachWorkspace'
const DEFAULT_AGENT_PRESET = 'dsh.defaultAgentPreset'
const HISTORY_PAGE_SIZE = 'dsh.historyPageSize'
const RECONNECT_INTERVAL = 'dsh.reconnectIntervalMs'

export interface DshConfig {
  serverUrl: string
  autoConnect: boolean
  autoAttachWorkspace: boolean
  defaultAgentPreset: string
  historyPageSize: number
  reconnectIntervalMs: number
}

export function readConfig(): DshConfig {
  const config = vscode.workspace.getConfiguration('dsh')
  return {
    serverUrl: config.get<string>(SERVER_URL.replace('dsh.', ''), 'http://127.0.0.1:3080'),
    autoConnect: config.get<boolean>(AUTO_CONNECT.replace('dsh.', ''), true),
    autoAttachWorkspace: config.get<boolean>(AUTO_ATTACH_WORKSPACE.replace('dsh.', ''), true),
    defaultAgentPreset: config.get<string>(DEFAULT_AGENT_PRESET.replace('dsh.', ''), 'standard'),
    historyPageSize: config.get<number>(HISTORY_PAGE_SIZE.replace('dsh.', ''), 40),
    reconnectIntervalMs: config.get<number>(RECONNECT_INTERVAL.replace('dsh.', ''), 3000),
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
