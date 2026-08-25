/**
 * Render types + webview op protocol shared by the host-side chat model and
 * the chat webview. Ops flow host → webview; requests flow webview → host.
 */

import type { QuestionItem, SessionModels } from '../client/types.ts'

export interface RenderToolCall {
  callId: string
  name: string
  arguments: string
  result?: string
  isError?: boolean
  status: 'pending' | 'running' | 'done' | 'error'
}

export interface RenderMessage {
  /** Stable id: message id when the event carries one, else `m-{turn}-{step}`. */
  id: string
  role: 'user' | 'assistant' | 'system'
  /** Extra label for non-human user sources (agent.inject, goal rounds…). */
  label?: string
  text: string
  reasoning?: string
  toolCalls: RenderToolCall[]
  streaming?: boolean
  interrupted?: boolean
  time: number
}

/** 用量统计（来自 sessionStats / tokenUsage / contextPressure 投影）。 */
export interface SessionStatsView {
  turns?: number
  steps?: number
  llmMs?: number
  toolMs?: number
  decodeTokens?: number
  uncachedInputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export type HostToWebviewOp =
  | { type: 'init'; sessionId: string; title?: string; cwd?: string; running: boolean; messages: RenderMessage[]; showReasoning: boolean }
  | { type: 'connection'; connected: boolean }
  | { type: 'models'; current: { provider: string; model: string; reasoningEffort?: string } | null; routable: boolean; groups: SessionModels['groups']; failures: SessionModels['failures'] }
  | { type: 'stats'; stats: SessionStatsView }
  | { type: 'append-message'; message: RenderMessage }
  | { type: 'stream-text'; id: string; text: string }
  | { type: 'stream-reasoning'; id: string; text: string }
  | { type: 'finalize-message'; id: string; message: RenderMessage }
  | { type: 'tool-call'; messageId?: string; tool: RenderToolCall }
  | { type: 'tool-result'; callId: string; result: string; isError?: boolean }
  | { type: 'approval'; rpcId: string; approvalId: string; toolName: string; reason?: string }
  | { type: 'approval-resolved'; approvalId: string; outcome: string }
  | { type: 'question'; rpcId: string; questions: QuestionItem[] }
  | { type: 'question-resolved'; questionRpcId: string; outcome: string }
  | { type: 'turn-end'; turn: number; reasonKind: string }
  | { type: 'title'; title: string }
  | { type: 'status'; text: string }
  | { type: 'error'; text: string }

export type WebviewToHostRequest =
  | { type: 'ready' }
  | { type: 'prompt'; text: string }
  | { type: 'cancel' }
  | { type: 'approve'; rpcId: string; approvalId: string }
  | { type: 'reject'; rpcId: string; approvalId: string }
  | { type: 'answer'; rpcId: string; answers: { id: string; selected: string[]; custom?: string }[] }
  | { type: 'model-change'; provider: string; model: string }
  | { type: 'open-in-browser' }

/** Default truncation cap for tool results before shipping to the webview. */
export const MAX_TOOL_RESULT_CHARS = 4000
