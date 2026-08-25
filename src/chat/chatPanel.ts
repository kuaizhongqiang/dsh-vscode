/**
 * Chat panel: one webview per session, backed by a ChatModel. Owns the
 * webview lifecycle, forwards ops to the webview and webview requests back to
 * the connection (prompt/cancel/approve/reject/answer).
 */

import * as vscode from 'vscode'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DshConnection, DshEvent } from '../client/connection.ts'
import { ChatModel } from './chatModel.ts'
import type { HostToWebviewOp, WebviewToHostRequest } from './types.ts'
import { sessionWebUrl } from '../config.ts'

export interface ChatPanelContext {
  extensionUri: vscode.Uri
  connection: DshConnection
  sessionId: string
  title?: string
  cwd?: string
  running: boolean
  historyPageSize: number
  showReasoning: boolean
  maxToolResultChars: number
  onTitleChanged?: (title: string) => void
  onStateChanged?: () => void
}

export class ChatPanel {
  private static readonly open = new Map<string, ChatPanel>()

  static openOrFocus(context: ChatPanelContext): ChatPanel {
    const existing = ChatPanel.open.get(context.sessionId)
    if (existing !== undefined) {
      existing.panel.reveal(vscode.ViewColumn.Beside, true)
      existing.updateContext(context)
      return existing
    }
    const panel = new ChatPanel(context)
    ChatPanel.open.set(context.sessionId, panel)
    return panel
  }

  static disposeAll(): void {
    for (const panel of [...ChatPanel.open.values()]) panel.dispose()
  }

  readonly panel: vscode.WebviewPanel
  private readonly context: ChatPanelContext
  private readonly model: ChatModel
  private readonly disposables: vscode.Disposable[] = []
  private disposed = false
  private webviewReady = false
  private pendingOps: HostToWebviewOp[] = []
  private title: string | undefined
  private running: boolean

  private constructor(context: ChatPanelContext) {
    this.context = context
    this.title = context.title
    this.running = context.running

    this.panel = vscode.window.createWebviewPanel(
      'dsh.chat',
      this.title ?? 'DSH 会话',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      },
    )
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'dsh-icon.svg')

    this.model = new ChatModel({
      connection: context.connection,
      sessionId: context.sessionId,
      onOp: (op) => this.postOp(op),
      maxToolResultChars: context.maxToolResultChars,
    })

    const offConnection = context.connection.onEvent((event) => this.handleConnectionEvent(event))
    this.disposables.push(
      { dispose: offConnection },
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.handleWebviewMessage(message)),
    )

    this.panel.webview.html = this.buildHtml()
    void this.model.load(context.historyPageSize)
  }

  get sessionId(): string {
    return this.context.sessionId
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside, true)
  }

  /** Refresh context (title/running) when the same session is re-opened. */
  updateContext(context: ChatPanelContext): void {
    if (context.title !== undefined && context.title !== this.title) {
      this.title = context.title
      this.panel.title = context.title
      this.postOp({ type: 'title', title: context.title })
      this.context.onTitleChanged?.(context.title)
    }
    this.running = context.running
    this.postOp({ type: 'status', text: this.running ? '运行中' : '空闲' })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ChatPanel.open.delete(this.sessionId)
    this.model.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }

  // ---- outbound ----

  private postOp(op: HostToWebviewOp): void {
    if (!this.webviewReady) {
      this.pendingOps.push(op)
      if (this.pendingOps.length > 200) this.pendingOps.shift()
      return
    }
    void this.panel.webview.postMessage(op)
  }

  private flushPending(): void {
    for (const op of this.pendingOps) {
      void this.panel.webview.postMessage(op)
    }
    this.pendingOps = []
  }

  // ---- connection events for this session (approvals/questions) ----

  private handleConnectionEvent(event: DshEvent): void {
    // Global connection-state changes gate the input box.
    if (event.kind === 'connected' || event.kind === 'disconnected') {
      this.postOp({ type: 'connection', connected: event.kind === 'connected' })
      return
    }
    if (!('sessionId' in event) || event.sessionId !== this.sessionId) return
    switch (event.kind) {
      case 'projection':
        if (event.key === 'title' && typeof event.value === 'string' && event.value !== this.title) {
          this.title = event.value
          this.panel.title = event.value
          this.postOp({ type: 'title', title: event.value })
          this.context.onTitleChanged?.(event.value)
        }
        break
      case 'approval-requested':
        this.postOp({
          type: 'approval',
          rpcId: event.rpcId,
          approvalId: event.frame.approvalId,
          toolName: event.frame.toolName,
          reason: event.frame.reason,
        })
        break
      case 'approval-resolved':
        this.postOp({
          type: 'approval-resolved',
          approvalId: event.frame.approvalId,
          outcome: event.frame.outcome,
        })
        break
      case 'question-requested':
        this.postOp({ type: 'question', rpcId: event.rpcId, questions: event.frame.questions })
        break
      case 'question-resolved':
        this.postOp({ type: 'question-resolved', questionRpcId: event.frame.questionRpcId, outcome: event.frame.outcome })
        break
      default:
        break
    }
  }

  // ---- webview -> host ----

  private handleWebviewMessage(raw: unknown): void {
    const message = raw as WebviewToHostRequest
    switch (message.type) {
      case 'ready':
        this.webviewReady = true
        this.postOp({ type: 'connection', connected: this.context.connection.connected })
        this.postOp({
          type: 'init',
          sessionId: this.sessionId,
          title: this.title,
          cwd: this.context.cwd,
          running: this.running,
          messages: this.model.snapshot(),
          showReasoning: this.context.showReasoning,
        })
        this.flushPending()
        void this.loadModels()
        break
      case 'prompt':
        void this.sendPrompt(message.text)
        break
      case 'cancel':
        void this.context.connection.cancel(this.sessionId).catch((error) => {
          this.postOp({ type: 'error', text: `停止失败：${errorMessage(error)}` })
        })
        break
      case 'model-change':
        void this.selectModel(message.provider, message.model)
        break
      case 'approve':
        void this.context.connection.approve(message.rpcId, this.sessionId, message.approvalId).catch((error) => {
          this.postOp({ type: 'error', text: `审批应答失败：${errorMessage(error)}` })
        })
        break
      case 'reject':
        void this.context.connection.reject(message.rpcId, this.sessionId, message.approvalId).catch((error) => {
          this.postOp({ type: 'error', text: `拒绝应答失败：${errorMessage(error)}` })
        })
        break
      case 'answer':
        void this.context.connection.answerQuestion(message.rpcId, this.sessionId, message.answers).catch((error) => {
          this.postOp({ type: 'error', text: `回答提交失败：${errorMessage(error)}` })
        })
        break
      case 'open-in-browser':
        void vscode.env.openExternal(vscode.Uri.parse(sessionWebUrl(this.context.connection.baseUrl, this.sessionId)))
        break
    }
  }

  private async sendPrompt(text: string): Promise<void> {
    try {
      await this.context.connection.prompt(this.sessionId, text, 'queue')
    } catch (error) {
      this.postOp({ type: 'error', text: `发送失败：${errorMessage(error)}` })
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await this.context.connection.models(this.sessionId)
      this.postOp({
        type: 'models',
        current: models.current,
        routable: models.routable,
        groups: models.groups,
        failures: models.failures,
      })
    } catch (error) {
      // Model catalog is advisory; a failure must not block chat.
      this.postOp({ type: 'status', text: `模型目录加载失败：${errorMessage(error)}` })
    }
  }

  private async selectModel(provider: string, model: string): Promise<void> {
    try {
      await this.context.connection.selectModel(this.sessionId, provider, model)
      this.postOp({ type: 'status', text: `已切换模型：${provider}/${model}` })
    } catch (error) {
      this.postOp({ type: 'error', text: `切换模型失败：${errorMessage(error)}` })
    }
  }

  // ---- html ----

  private buildHtml(): string {
    const file = join(this.context.extensionUri.fsPath, 'media', 'webview.html')
    let html: string
    try {
      html = readFileSync(file, 'utf8')
    } catch {
      return '<html><body><h1>webview.html 缺失</h1></body></html>'
    }
    return html
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
