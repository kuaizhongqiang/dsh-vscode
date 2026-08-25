/**
 * Per-session chat model: renders durable history + live session events into
 * RenderMessages, and emits incremental ops for the webview. Seamlessly
 * handles the history/live overlap by seq-deduping.
 */

import type { DshConnection } from '../client/connection.ts'
import type {
  AssistantMessageEvent,
  ContentBlock,
  SessionEvent,
  SessionId,
  StreamChunk,
  ToolCallEvent,
  ToolResultEvent,
  UserMessageEvent,
} from '../client/types.ts'
import { MAX_TOOL_RESULT_CHARS, type HostToWebviewOp, type RenderMessage, type RenderToolCall } from './types.ts'

export interface ChatModelOptions {
  connection: DshConnection
  sessionId: SessionId
  onOp: (op: HostToWebviewOp) => void
}

interface StreamingState {
  id: string
  turn: number
  step: number
  blocks: Map<number, { kind: 'text' | 'reasoning' | 'tool-call' | 'unknown'; text: string; callId?: string }>
}

const UNKNOWN_SOURCE_LABELS: Record<string, string> = {
  'agent.inject': '注入',
  'agent/prompt': '注入',
  'goal': '目标续跑',
}

export class ChatModel {
  private readonly connection: DshConnection
  private readonly sessionId: SessionId
  private readonly onOp: (op: HostToWebviewOp) => void
  private readonly messages: RenderMessage[] = []
  private readonly toolCalls = new Map<string, RenderToolCall>()
  private maxSeq = 0
  private streaming: StreamingState | undefined
  private loaded = false
  private disposed = false
  private readonly offConnection: () => void
  private liveBuffer: SessionEvent[] = []

  constructor(options: ChatModelOptions) {
    this.connection = options.connection
    this.sessionId = options.sessionId
    this.onOp = options.onOp
    // Subscribe to live events first so nothing falls into the history/live gap.
    this.offConnection = this.connection.onEvent((event) => {
      if (event.kind !== 'session-event' || event.sessionId !== this.sessionId) return
      if (!this.loaded) {
        this.liveBuffer.push(event.event)
        return
      }
      this.applyEvent(event.event, true)
    })
  }

  /** Load durable history, then flush buffered live events (seq-deduped). */
  async load(maxMessages: number): Promise<void> {
    if (this.loaded) return
    try {
      const result = await this.connection.history(this.sessionId, maxMessages)
      for (const entry of result.events) {
        if (entry.event.seq > this.maxSeq) this.maxSeq = entry.event.seq
        this.applyEvent(entry.event, false)
      }
      this.loaded = true
      for (const event of this.liveBuffer) this.applyEvent(event, true)
      this.liveBuffer = []
    } catch (error) {
      // History is best-effort; keep the model usable for live streaming.
      this.loaded = true
      this.liveBuffer = []
      this.onOp({ type: 'error', text: `加载历史失败：${error instanceof Error ? error.message : String(error)}` })
    }
  }

  dispose(): void {
    this.disposed = true
    this.offConnection()
  }

  snapshot(): RenderMessage[] {
    return this.messages.map((message) => ({ ...message, toolCalls: [...message.toolCalls] }))
  }

  private applyEvent(event: SessionEvent, live: boolean): void {
    if (this.disposed) return
    if (event.seq <= this.maxSeq && this.loaded) return
    if (event.seq > this.maxSeq) this.maxSeq = event.seq
    switch (event.type) {
      case 'user/message':
        this.handleUserMessage(event as unknown as UserMessageEvent)
        break
      case 'assistant/chunk':
        if (live) this.handleChunk(event.data as { turn: number; step: number; chunk: StreamChunk })
        break
      case 'assistant/message':
        this.handleAssistantMessage(event as unknown as AssistantMessageEvent)
        break
      case 'tool/call':
        this.handleToolCall(event as unknown as ToolCallEvent)
        break
      case 'tool/result':
        this.handleToolResult(event as unknown as ToolResultEvent)
        break
      case 'turn/end': {
        const data = event.data as { turn: number; reason: { kind: string } }
        this.onOp({ type: 'turn-end', turn: data.turn, reasonKind: data.reason?.kind ?? 'unknown' })
        break
      }
      default:
        break
    }
  }

  // ---- Event handlers ----

  private handleUserMessage(event: UserMessageEvent): void {
    const data = event.data
    const text = extractText(data.content)
    const sourceKind = data.source?.kind
    const label = sourceKind !== undefined && sourceKind !== 'user' && sourceKind !== 'user-rpc'
      ? (UNKNOWN_SOURCE_LABELS[sourceKind] ?? sourceKind)
      : undefined
    const message: RenderMessage = {
      id: data.id ?? `user-${event.seq}`,
      role: 'user',
      label,
      text,
      toolCalls: [],
      time: event.time,
    }
    this.messages.push(message)
    this.onOp({ type: 'append-message', message })
  }

  private handleChunk(data: { turn: number; step: number; chunk: StreamChunk }): void {
    const { turn, step, chunk } = data
    if (this.streaming === undefined || this.streaming.turn !== turn || this.streaming.step !== step) {
      this.streaming = { id: `m-${turn}-${step}`, turn, step, blocks: new Map() }
      this.messages.push({
        id: this.streaming.id,
        role: 'assistant',
        text: '',
        toolCalls: [],
        streaming: true,
        time: Date.now(),
      })
      this.onOp({ type: 'append-message', message: this.messages[this.messages.length - 1]! })
    }
    const state = this.streaming
    switch (chunk.type) {
      case 'block-start': {
        const kind = chunk.blockType === 'text' ? 'text'
          : chunk.blockType === 'reasoning' ? 'reasoning'
            : chunk.blockType === 'tool-call' ? 'tool-call' : 'unknown'
        state.blocks.set(chunk.index, { kind, text: '' })
        break
      }
      case 'text-delta': {
        const block = this.ensureBlock(state, chunk.index, 'text')
        block.text += chunk.text
        this.onOp({ type: 'stream-text', id: state.id, text: chunk.text })
        break
      }
      case 'reasoning-delta': {
        const block = this.ensureBlock(state, chunk.index, 'reasoning')
        block.text += chunk.text
        this.onOp({ type: 'stream-reasoning', id: state.id, text: chunk.text })
        break
      }
      case 'tool-call-delta': {
        const block = this.ensureBlock(state, chunk.index, 'tool-call')
        block.text += chunk.argumentsDelta
        block.callId = chunk.id
        // Live tool card: name + arguments-so-far.
        const existing = this.toolCalls.get(chunk.id)
        const tool: RenderToolCall = {
          callId: chunk.id,
          name: chunk.name,
          arguments: block.text,
          status: existing?.status ?? 'pending',
        }
        this.toolCalls.set(chunk.id, tool)
        this.onOp({ type: 'tool-call', messageId: state.id, tool })
        break
      }
      default:
        break
    }
  }

  private ensureBlock(
    state: StreamingState,
    index: number,
    kind: 'text' | 'reasoning' | 'tool-call',
  ): { kind: 'text' | 'reasoning' | 'tool-call' | 'unknown'; text: string; callId?: string } {
    const existing = state.blocks.get(index)
    if (existing !== undefined) return existing
    const block = { kind, text: '' }
    state.blocks.set(index, block)
    return block
  }

  private handleAssistantMessage(event: AssistantMessageEvent): void {
    const data = event.data
    const message = data.message
    const text = extractText(message.content.filter((block) => block.type === 'text'))
    const reasoning = extractText(message.content.filter((block) => block.type === 'reasoning'))
    const id = message.id ?? `m-${data.turn}-${data.step}`
    const toolCallBlocks = message.content.filter((block): block is Extract<ContentBlock, { type: 'tool-call' }> =>
      block.type === 'tool-call')
    // Sync tool calls from the final message blocks (complete arguments).
    for (const block of toolCallBlocks) {
      const existing = this.toolCalls.get(block.id)
      const tool: RenderToolCall = {
        callId: block.id,
        name: block.name,
        arguments: block.arguments || (existing?.arguments ?? ''),
        status: existing?.status ?? 'pending',
      }
      this.toolCalls.set(block.id, tool)
      this.onOp({ type: 'tool-call', messageId: id, tool })
    }
    const render: RenderMessage = {
      id,
      role: 'assistant',
      text,
      reasoning: reasoning || undefined,
      toolCalls: toolCallBlocks.map((block) => this.toolCalls.get(block.id) ?? {
        callId: block.id,
        name: block.name,
        arguments: block.arguments,
        status: 'pending',
      }),
      interrupted: data.interrupted === true,
      time: event.time,
    }
    const index = this.messages.findIndex((m) => m.id === id)
    if (index >= 0) {
      this.messages[index] = render
    } else {
      this.messages.push(render)
    }
    if (this.streaming !== undefined && this.streaming.turn === data.turn && this.streaming.step === data.step) {
      this.streaming = undefined
    }
    this.onOp({ type: 'finalize-message', id, message: render })
  }

  private handleToolCall(event: ToolCallEvent): void {
    const data = event.data
    const existing = this.toolCalls.get(data.callId)
    const tool: RenderToolCall = {
      callId: data.callId,
      name: data.name,
      arguments: data.arguments || (existing?.arguments ?? ''),
      status: existing?.status ?? 'running',
    }
    this.toolCalls.set(data.callId, tool)
    this.onOp({ type: 'tool-call', tool })
  }

  private handleToolResult(event: ToolResultEvent): void {
    const data = event.data
    const callId = data.message.source?.callId
    if (callId === undefined) return
    const existing = this.toolCalls.get(callId)
    const isError = data.error !== undefined || data.message.isError === true
    const raw = extractText(data.message.content)
    const result = raw.length > MAX_TOOL_RESULT_CHARS
      ? `${raw.slice(0, MAX_TOOL_RESULT_CHARS)}\n…（结果过长已截断）`
      : raw
    this.toolCalls.set(callId, {
      callId,
      name: existing?.name ?? '',
      arguments: existing?.arguments ?? '',
      result,
      isError,
      status: isError ? 'error' : 'done',
    })
    this.onOp({ type: 'tool-result', callId, result, isError })
  }
}

/** Extract display text from content blocks (recurses into tool-result content). */
export function extractText(blocks: ContentBlock[]): string {
  const parts: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text)
        break
      case 'reasoning':
        parts.push(block.text)
        break
      case 'tool-result':
        parts.push(extractText(block.content))
        break
      default:
        break
    }
  }
  return parts.join('')
}

export type { HostToWebviewOp }
