/**
 * dsh-vscode extension entry: activation, connection lifecycle, commands,
 * sidebar, status bar, and workspace auto-attach.
 */

import * as vscode from 'vscode'
import { realpathSync } from 'node:fs'
import { DshConnection } from './client/connection.ts'
import type { DshEvent } from './client/connection.ts'
import { RpcErrorResult, DshTransportError } from './client/rpc.ts'
import { SessionStore } from './sessionStore.ts'
import { SessionsTreeProvider } from './sidebar.ts'
import { StatusBar } from './statusBar.ts'
import { ChatPanel, errorMessage } from './chat/chatPanel.ts'
import type { SessionStatsView } from './chat/types.ts'
import { onConfigChanged, readConfig, sessionWebUrl, type DshConfig } from './config.ts'
import type { SessionId, WorkspaceId } from './client/types.ts'

let extension: DshExtension | undefined

export function activate(context: vscode.ExtensionContext): void {
  extension = new DshExtension(context)
  extension.activate()
  context.subscriptions.push({
    dispose: () => {
      extension?.dispose()
      extension = undefined
    },
  })
}

export function deactivate(): void {
  extension?.dispose()
  extension = undefined
}

class DshExtension {
  readonly output: vscode.OutputChannel
  private readonly context: vscode.ExtensionContext
  private readonly statusBar: StatusBar
  private readonly disposables: vscode.Disposable[] = []

  private connection: DshConnection | undefined
  private store: SessionStore | undefined
  private treeProvider: SessionsTreeProvider | undefined
  private treeView: vscode.TreeView<unknown> | undefined
  private currentWorkspaceId: WorkspaceId | undefined
  private currentWorkspacePath: string | undefined
  private connecting = false
  private config: DshConfig

  constructor(context: vscode.ExtensionContext) {
    this.context = context
    this.config = readConfig()
    this.output = vscode.window.createOutputChannel('DSH')
    this.statusBar = new StatusBar()
  }

  activate(): void {
    this.output.appendLine(`[dsh-vscode] 启动，serverUrl=${this.config.serverUrl}`)

    this.disposables.push(
      this.statusBar,
      this.output,
      vscode.commands.registerCommand('dsh.connect', () => this.connect()),
      vscode.commands.registerCommand('dsh.disconnect', () => this.disconnect()),
      vscode.commands.registerCommand('dsh.openChat', () => this.openChat()),
      vscode.commands.registerCommand('dsh.newSession', () => this.newSession()),
      vscode.commands.registerCommand('dsh.refreshSessions', () => this.refreshSessions()),
      vscode.commands.registerCommand('dsh.openInBrowser', () => this.openInBrowser()),
      vscode.commands.registerCommand('dsh.cancel', () => this.cancelSelected()),
      vscode.commands.registerCommand('dsh.renameSession', () => this.renameSelected()),
      vscode.commands.registerCommand('dsh.showOutput', () => this.output.show()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.handleWorkspaceChange()),
      onConfigChanged(() => this.handleConfigChanged()),
    )

    void this.ensureWorkspaceAttach()
    if (this.config.autoConnect) {
      void this.connect()
    }
    // Tree view (provider may be empty until the store exists; rebuild on connect).
    this.treeProvider = new SessionsTreeProvider(() => this.store)
    this.treeView = vscode.window.createTreeView('dsh.sessions', { treeDataProvider: this.treeProvider })
    this.disposables.push(this.treeView)
  }

  dispose(): void {
    ChatPanel.disposeAll()
    this.connection?.dispose()
    this.store?.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }

  // ---- connection lifecycle ----

  private async connect(): Promise<void> {
    if (this.connecting) return
    this.connecting = true
    this.statusBar.setState('connecting')
    try {
      const connection = new DshConnection(this.config.serverUrl, {
        reconnectIntervalMs: this.config.reconnectIntervalMs,
      })
      const off = connection.onEvent((event) => this.handleConnectionEvent(event))
      this.disposables.push({ dispose: off })
      await connection.connect()
      this.connection = connection
      await vscode.commands.executeCommand('setContext', 'dsh.connected', true)
      this.statusBar.setState('connected', '已连接')
      this.output.appendLine(`[dsh-vscode] 已连接 ${connection.baseUrl}`)
      await this.initStore()
      await this.ensureWorkspaceAttach()
      this.refreshTree()
    } catch (error) {
      this.connection?.dispose()
      this.connection = undefined
      await vscode.commands.executeCommand('setContext', 'dsh.connected', false)
      this.statusBar.setState('error')
      const message = errorMessage(error)
      this.output.appendLine(`[dsh-vscode] 连接失败: ${message}`)
      const retry = await vscode.window.showErrorMessage(
        `无法连接 DSH 服务 ${this.config.serverUrl}：${message}`,
        { modal: false },
        '重试',
        '设置',
      )
      if (retry === '重试') void this.connect()
      if (retry === '设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'dsh.serverUrl')
    } finally {
      this.connecting = false
    }
  }

  private disconnect(): void {
    this.connection?.dispose()
    this.connection = undefined
    this.store?.dispose()
    this.store = undefined
    void vscode.commands.executeCommand('setContext', 'dsh.connected', false)
    this.statusBar.setState('disconnected')
    this.output.appendLine('[dsh-vscode] 已断开')
    this.refreshTree()
  }

  private async initStore(): Promise<void> {
    if (this.connection === undefined) return
    this.store?.dispose()
    this.store = new SessionStore(this.connection)
    this.store.onChanged(() => this.refreshTree())
    await this.store.refresh()
  }

  private handleConnectionEvent(event: DshEvent): void {
    switch (event.kind) {
      case 'connected':
        this.statusBar.setState('connected', '已连接')
        void this.initStore()
        break
      case 'disconnected':
        this.statusBar.setState('error', '已断开')
        this.output.appendLine(`[dsh-vscode] 事件流断开: ${event.reason}`)
        break
      case 'stream-error':
        this.output.appendLine(`[dsh-vscode] 事件流错误: ${errorMessage(event.error)}`)
        break
      case 'host-frame': {
        const frame = event.frame as { type: string; [k: string]: unknown }
        if (frame.type === 'host/session-added' || frame.type === 'host/session-removed') {
          // Store handles these; nothing extra needed.
        }
        break
      }
      default:
        break
    }
  }

  private handleConfigChanged(): void {
    const next = readConfig()
    const serverChanged = next.serverUrl !== this.config.serverUrl
    this.config = next
    if (serverChanged) {
      this.output.appendLine(`[dsh-vscode] serverUrl 变更为 ${next.serverUrl}，重新连接`)
      this.disconnect()
      void this.connect()
    }
  }

  // ---- store / tree ----

  private refreshTree(): void {
    this.treeProvider?.refresh()
  }

  private selectedSession(): SessionId | undefined {
    const selection = this.treeView?.selection
    if (selection === undefined) return undefined
    const node = selection as { kind?: string; session?: { sessionId: SessionId } }
    if (node?.kind === 'session' && node.session) return node.session.sessionId
    return undefined
  }

  // ---- workspace auto-attach ----

  private async ensureWorkspaceAttach(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0]
    if (folder === undefined) return
    if (!this.config.autoAttachWorkspace) return
    let path = folder.uri.fsPath
    try {
      path = realpathSync(path)
    } catch {
      // keep the original path if realpath fails
    }
    if (this.currentWorkspacePath === path && this.currentWorkspaceId !== undefined) return
    if (this.connection === undefined) {
      // Remember intent; attach happens after connect().
      this.currentWorkspacePath = path
      return
    }
    try {
      const workspaces = await this.connection.listWorkspaces()
      const existing = workspaces.find((workspace) => workspace.path === path)
      if (existing !== undefined) {
        this.currentWorkspaceId = existing.workspaceId
        this.currentWorkspacePath = existing.path
        this.output.appendLine(`[dsh-vscode] 关联工作区: ${existing.title} (${existing.path})`)
        return
      }
      const { workspace } = await this.connection.createWorkspace(path)
      this.currentWorkspaceId = workspace.workspaceId
      this.currentWorkspacePath = workspace.path
      this.output.appendLine(`[dsh-vscode] 创建并关联工作区: ${workspace.title} (${workspace.path})`)
    } catch (error) {
      this.output.appendLine(`[dsh-vscode] 工作区关联失败: ${errorMessage(error)}`)
    }
  }

  private handleWorkspaceChange(): void {
    this.currentWorkspaceId = undefined
    this.currentWorkspacePath = undefined
    void this.ensureWorkspaceAttach()
  }

  // ---- commands ----

  private requireConnection(): DshConnection {
    if (this.connection === undefined) {
      throw new Error('尚未连接 DSH。请先执行 "DSH: 连接"（或检查 dsh.serverUrl 设置）。')
    }
    return this.connection
  }

  private async openChat(): Promise<void> {
    try {
      const connection = this.requireConnection()
      const selection = this.selectedSession()
      let sessionId = selection
      if (sessionId === undefined) {
        sessionId = await this.pickSession(connection)
      }
      if (sessionId === undefined) return
      this.openChatPanel(sessionId)
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private openChatPanel(sessionId: SessionId): void {
    if (this.connection === undefined) return
    const session = this.store?.getSession(sessionId)
    const panel = ChatPanel.openOrFocus({
      extensionUri: this.context.extensionUri,
      connection: this.connection,
      sessionId,
      title: session?.title,
      cwd: session?.cwd,
      running: session?.running ?? false,
      historyPageSize: this.config.historyPageSize,
      showReasoning: this.config.showReasoning,
      maxToolResultChars: this.config.maxToolResultChars,
      initialStats: initialStatsOf(session),
      onTitleChanged: (title) => {
        const current = this.store?.getSession(sessionId)
        if (current !== undefined) {
          current.title = title
          this.refreshTree()
        }
      },
    })
    void panel
  }

  private async pickSession(connection: DshConnection): Promise<SessionId | undefined> {
    const entries = this.store?.allSessions ?? []
    if (entries.length === 0) {
      const answer = await vscode.window.showInformationMessage('还没有会话，要新建一个吗？', '新建会话', '取消')
      if (answer === '新建会话') return this.createSessionAndOpen()
      return undefined
    }
    const items = entries.slice(0, 50).map((session) => ({
      label: session.title ?? '新会话',
      description: `${session.running ? '🔄 ' : ''}${session.agentPreset}`,
      detail: session.cwd,
      sessionId: session.sessionId,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择要打开的会话',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    void connection
    return picked?.sessionId
  }

  private async newSession(): Promise<void> {
    try {
      this.requireConnection()
      await this.createSessionAndOpen()
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private async createSessionAndOpen(): Promise<SessionId | undefined> {
    if (this.connection === undefined) return undefined
    await this.ensureWorkspaceAttach()
    try {
      const preset = await this.pickPreset()
      const workspaceId = await this.pickWorkspace()
      const { sessionId } = await this.connection.createSession({
        workspaceId,
        agentPreset: preset ?? this.config.defaultAgentPreset,
      })
      this.output.appendLine(`[dsh-vscode] 新建会话 ${sessionId}${preset !== undefined ? `（preset=${preset}）` : ''}`)
      await this.store?.refresh()
      if (this.config.autoOpenChat) this.openChatPanel(sessionId)
      return sessionId
    } catch (error) {
      if (error instanceof RpcErrorResult && error.code === 'agent-preset-not-found') {
        // Fall back to the server default preset.
        const { sessionId } = await this.connection.createSession({ workspaceId: this.currentWorkspaceId })
        this.output.appendLine(`[dsh-vscode] 新建会话 ${sessionId}（默认 preset）`)
        await this.store?.refresh()
        if (this.config.autoOpenChat) this.openChatPanel(sessionId)
        return sessionId
      }
      throw error
    }
  }

  /** Ask for an agent preset when the server offers more than one. */
  private async pickPreset(): Promise<string | undefined> {
    if (this.connection === undefined) return undefined
    try {
      const presets = await this.connection.listPresets()
      if (presets.length <= 1) return undefined
      const items = presets.map((preset) => ({
        label: preset.id,
        description: preset.isDefault ? '默认' : preset.trust === 'user' ? '本地' : '系统',
        preset: preset.id,
      }))
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '选择会话的 agent preset（跳过则用默认）',
        matchOnDescription: true,
      })
      return picked?.preset
    } catch {
      return undefined // preset 目录加载失败时静默使用配置默认值
    }
  }

  /** Ask for a workspace when more than one exists. */
  private async pickWorkspace(): Promise<string | undefined> {
    const workspaces = this.store?.allWorkspaces ?? []
    if (workspaces.length <= 1) return this.currentWorkspaceId
    const items = workspaces.map((workspace) => ({
      label: workspace.title,
      description: workspace.path,
      workspaceId: workspace.workspaceId,
    }))
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: '选择新会话所在的工作区',
      matchOnDetail: true,
    })
    return picked?.workspaceId ?? this.currentWorkspaceId
  }

  private async refreshSessions(): Promise<void> {
    try {
      this.requireConnection()
      this.statusBar.setState('connecting', '刷新中')
      await this.store?.refresh()
      this.statusBar.setState('connected', '已连接')
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private async openInBrowser(): Promise<void> {
    const sessionId = this.selectedSession()
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage('请先在会话列表中选中一个会话')
      return
    }
    if (this.connection === undefined) return
    void vscode.env.openExternal(vscode.Uri.parse(sessionWebUrl(this.connection.baseUrl, sessionId)))
  }

  private async cancelSelected(): Promise<void> {
    const sessionId = this.selectedSession()
    if (sessionId === undefined) return
    try {
      const connection = this.requireConnection()
      await connection.cancel(sessionId)
      this.output.appendLine(`[dsh-vscode] 已请求停止 ${sessionId}`)
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }

  private async renameSelected(): Promise<void> {
    const sessionId = this.selectedSession()
    if (sessionId === undefined) {
      void vscode.window.showInformationMessage('请先在会话列表中选中一个会话')
      return
    }
    try {
      const connection = this.requireConnection()
      const session = this.store?.getSession(sessionId)
      const title = await vscode.window.showInputBox({
        prompt: '会话新标题',
        value: session?.title ?? '',
        placeHolder: '输入标题，留空则取消',
      })
      if (title === undefined) return
      await connection.rename(sessionId, title.trim())
      await this.store?.refresh()
    } catch (error) {
      void vscode.window.showErrorMessage(errorMessage(error))
    }
  }
}

export { DshTransportError }

/** 从 store 会话的投影快照里取初始用量统计。 */
function initialStatsOf(session: { projections: Map<string, { value: unknown }> } | undefined): SessionStatsView | undefined {
  if (session === undefined) return undefined
  const stats: SessionStatsView = {}
  const pick = (key: string, field: string): void => {
    const entry = session.projections.get(key)
    const record = entry?.value as Record<string, unknown> | undefined
    const value = record?.[field]
    if (typeof value === 'number' && Number.isFinite(value)) {
      ;(stats as Record<string, unknown>)[field] = value
    }
  }
  for (const field of ['turns', 'steps', 'llmMs', 'toolMs', 'decodeTokens']) pick('sessionStats', field)
  for (const field of ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) pick('tokenUsage', field)
  for (const field of ['pressureTokens', 'projectedTokens', 'contextWindow']) pick('contextPressure', field)
  return Object.keys(stats).length > 0 ? stats : undefined
}
