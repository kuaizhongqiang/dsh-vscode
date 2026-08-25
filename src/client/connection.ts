/**
 * High-level DSH connection: unary RPC + mux event stream + typed event hub.
 * The single entry point the rest of the extension uses.
 */

import { DshRpcClient } from './rpc.ts'
import { MuxStreamClient } from './mux.ts'
import type {
  AgentPresetEntry,
  ApprovalRequestedFrame,
  ApprovalResolvedFrame,
  HostFrame,
  MuxFrame,
  QuestionRequestedFrame,
  QuestionResolvedFrame,
  SessionEvent,
  SessionHistoryResult,
  SessionId,
  SessionListEntry,
  SessionListResult,
  SessionModels,
  WorkspaceView,
} from './types.ts'

export type DshEvent =
  | { kind: 'connected'; baseUrl: string }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'session-event'; sessionId: SessionId; event: SessionEvent }
  | { kind: 'projection'; sessionId: SessionId; key: string; value: unknown; seq: number }
  | { kind: 'approval-requested'; sessionId: SessionId; rpcId: string; frame: ApprovalRequestedFrame }
  | { kind: 'approval-resolved'; sessionId: SessionId; frame: ApprovalResolvedFrame }
  | { kind: 'question-requested'; sessionId: SessionId; rpcId: string; frame: QuestionRequestedFrame }
  | { kind: 'question-resolved'; sessionId: SessionId; frame: QuestionResolvedFrame }
  | { kind: 'session-jobs'; sessionId: SessionId; jobs: unknown[] }
  | { kind: 'host-frame'; frame: { type: string; [k: string]: unknown } }
  | { kind: 'stream-error'; error: unknown }

export interface DshConnectionOptions {
  reconnectIntervalMs?: number
  /** Extra headers on every /api request and the mux WebSocket handshake (e.g. Cloudflare Access auth). */
  extraHeaders?: Record<string, string>
}

export type DshEventListener = (event: DshEvent) => void

export class DshConnection {
  readonly rpc: DshRpcClient
  private mux: MuxStreamClient | undefined
  private listeners = new Set<DshEventListener>()
  private reconnectIntervalMs: number
  private readonly extraHeaders: Record<string, string>

  constructor(baseUrl: string, options: DshConnectionOptions = {}) {
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 3000
    this.extraHeaders = options.extraHeaders ?? {}
    this.rpc = new DshRpcClient(baseUrl, this.extraHeaders)
  }

  get baseUrl(): string {
    return this.rpc.url
  }

  get connected(): boolean {
    return this.mux !== undefined && this.mux.connected
  }

  onEvent(listener: DshEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Establish the connection: verify the server answers, then open the mux
   * event stream (which reconnects itself afterwards). Idempotent.
   */
  async connect(): Promise<void> {
    if (this.mux !== undefined && this.mux.connected) return
    // Verification call — throws on network failure or bad URL.
    await this.rpc.call<unknown>('host.describe', {})
    if (this.mux === undefined) {
      this.mux = new MuxStreamClient(
        {
          baseUrl: this.rpc.url,
          reconnectIntervalMs: this.reconnectIntervalMs,
          extraHeaders: this.extraHeaders,
        },
        {
          onOpen: () => this.emit({ kind: 'connected', baseUrl: this.rpc.url }),
          onClose: (reason) => this.emit({ kind: 'disconnected', reason }),
          onError: (error) => this.emit({ kind: 'stream-error', error }),
          onFrame: (rpcId, frame) => this.handleFrame(rpcId, frame),
        },
      )
    }
    this.mux.connect()
  }

  disconnect(): void {
    this.mux?.close()
    this.mux = undefined
  }

  dispose(): void {
    this.disconnect()
    this.listeners.clear()
  }

  // ---- Sessions ----

  async listSessions(): Promise<SessionListEntry[]> {
    const result = await this.rpc.call<SessionListResult>('session.list', {})
    return result.items
  }

  async createSession(options: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  } = {}): Promise<{ sessionId: SessionId; agentPreset?: string }> {
    return this.rpc.call<{ sessionId: SessionId; agentPreset?: string }>('session.create', options)
  }

  async history(sessionId: SessionId, maxMessages = 40): Promise<SessionHistoryResult> {
    return this.rpc.call<SessionHistoryResult>('session.history', { sessionId, maxMessages })
  }

  async prompt(sessionId: SessionId, text: string, mode: 'queue' | 'steer' = 'queue'): Promise<void> {
    await this.rpc.call('session.prompt', {
      sessionId,
      mode,
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  }

  async cancel(sessionId: SessionId): Promise<void> {
    await this.rpc.call('session.cancel', { sessionId })
  }

  async rename(sessionId: SessionId, title: string): Promise<string> {
    const result = await this.rpc.call<{ title: string }>('session.rename', { sessionId, title })
    return result.title
  }

  async fork(sessionId: SessionId): Promise<SessionId> {
    const result = await this.rpc.call<{ sessionId: SessionId }>('session.fork', { sessionId })
    return result.sessionId
  }

  // ---- Workspaces ----

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const result = await this.rpc.call<{ items: WorkspaceView[]; archivedSessionIds: string[] }>('workspace.list', {})
    return result.items
  }

  async createWorkspace(path: string): Promise<{ workspace: WorkspaceView; created: boolean }> {
    return this.rpc.call<{ workspace: WorkspaceView; created: boolean }>('workspace.create', { path })
  }

  // ---- Models ----

  async models(sessionId: SessionId): Promise<SessionModels> {
    return this.rpc.call<SessionModels>('session.models', { sessionId })
  }

  async selectModel(sessionId: SessionId, provider: string, model: string): Promise<void> {
    await this.rpc.call('session.selectModel', { sessionId, provider, model })
  }

  // ---- Agent presets ----

  async listPresets(): Promise<AgentPresetEntry[]> {
    const result = await this.rpc.call<{ presets: AgentPresetEntry[] }>('agentPreset.list', {})
    return result.presets
  }

  // ---- Responding to server requests ----

  async approve(rpcId: string, sessionId: SessionId, approvalId: string): Promise<void> {
    await this.rpc.respond(rpcId, {
      sessionId,
      approvalId,
      outcome: 'allowed-once',
    })
  }

  async reject(rpcId: string, sessionId: SessionId, approvalId: string): Promise<void> {
    await this.rpc.respond(rpcId, {
      sessionId,
      approvalId,
      outcome: 'rejected',
    })
  }

  async answerQuestion(
    rpcId: string,
    sessionId: SessionId,
    answers: { id: string; selected: string[]; custom?: string }[],
  ): Promise<void> {
    await this.rpc.respond(rpcId, { sessionId, answer: { answers } })
  }

  // ---- Internals ----

  private handleFrame(rpcId: string, frame: MuxFrame): void {
    switch (frame.type) {
      case 'session/event': {
        const f = frame as { sessionId: SessionId; event: SessionEvent }
        this.emit({ kind: 'session-event', sessionId: f.sessionId, event: f.event })
        return
      }
      case 'session/projection': {
        const f = frame as { sessionId: SessionId; key: string; value: unknown; seq: number }
        this.emit({ kind: 'projection', sessionId: f.sessionId, key: f.key, value: f.value, seq: f.seq })
        return
      }
      case 'approval/requested': {
        const f = frame as ApprovalRequestedFrame
        this.emit({ kind: 'approval-requested', sessionId: f.sessionId, rpcId, frame: f })
        return
      }
      case 'approval/resolved': {
        const f = frame as ApprovalResolvedFrame
        this.emit({ kind: 'approval-resolved', sessionId: f.sessionId, frame: f })
        return
      }
      case 'question/requested': {
        const f = frame as QuestionRequestedFrame
        this.emit({ kind: 'question-requested', sessionId: f.sessionId, rpcId, frame: f })
        return
      }
      case 'question/resolved': {
        const f = frame as QuestionResolvedFrame
        this.emit({ kind: 'question-resolved', sessionId: f.sessionId, frame: f })
        return
      }
      case 'session/jobs': {
        const f = frame as { sessionId: SessionId; jobs: unknown[] }
        this.emit({ kind: 'session-jobs', sessionId: f.sessionId, jobs: f.jobs })
        return
      }
      case 'stream/error': {
        const f = frame as { error: unknown }
        this.emit({ kind: 'stream-error', error: f.error })
        return
      }
      default:
        // Host-level or unknown frames: forward generically.
        this.emit({ kind: 'host-frame', frame: frame as unknown as { type: string; [k: string]: unknown } })
    }
  }

  private emit(event: DshEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // a listener must not break the hub
      }
    }
  }
}
