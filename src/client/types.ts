/**
 * DSH wire protocol types — the minimal subset the extension speaks.
 * Mirrors the shapes in @deepseek-ai/dsh-host-apiproxy/api and the mux frame
 * union from the events contract. Keep this file dependency-free.
 */

// ---- RPC envelope ----

export type RpcId = string

export interface RpcError {
  code: string
  message: string
  details: unknown
}

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

export interface ClientRequest {
  type: 'client-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

export interface ServerResponse {
  type: 'server-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

export interface ServerRequest {
  type: 'server-request'
  rpcId: RpcId
  method: string
  payload: unknown
}

export interface ClientResponse {
  type: 'client-response'
  rpcId: RpcId
  result: RpcResult<unknown>
}

// ---- Session ----

export type SessionId = string

export interface SessionListEntry {
  sessionId: SessionId
  updatedAt: number
  running: boolean
  blank: boolean
  cwd: string
  agentPreset: string
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

export interface SessionListResult {
  items: SessionListEntry[]
}

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

export interface SessionHistoryResult {
  events: HistoryEntry[]
  hasMore: boolean
  projections?: {
    asOfSeq: number
    values: Record<string, unknown>
  }
}

// ---- Session events (wire view of the dsh-session log) ----

export interface SessionEventBase {
  seq: number
  type: string
  time: number
  source?: { kind: string; [k: string]: unknown }
  data: Record<string, unknown>
}

export type SessionEvent = SessionEventBase

/** User message projected by a user/message event. */
export interface UserMessageEvent {
  seq: number
  time: number
  type: 'user/message'
  data: {
    content: ContentBlock[]
    source?: { kind: string; [k: string]: unknown }
    role: 'user'
    id: string
  }
}

export interface AssistantChunkEvent {
  seq: number
  time: number
  type: 'assistant/chunk'
  data: { turn: number; step: number; chunk: StreamChunk }
}

export interface AssistantMessageEvent {
  seq: number
  time: number
  type: 'assistant/message'
  data: {
    turn: number
    step: number
    message: AssistantMessage
    interrupted?: true
  }
}

export interface ToolCallEvent {
  seq: number
  time: number
  type: 'tool/call'
  data: { turn: number; step: number; callId: string; name: string; arguments: string }
}

export interface ToolResultEvent {
  seq: number
  time: number
  type: 'tool/result'
  data: {
    turn: number
    step: number
    message: ToolResultMessage
    error?: { name: string; code: string }
  }
}

export interface TurnStartEvent {
  seq: number
  time: number
  type: 'turn/start'
  data: { turn: number }
}

export interface TurnEndEvent {
  seq: number
  time: number
  type: 'turn/end'
  data: { turn: number; reason: { kind: string; [k: string]: unknown } }
}

// ---- Content blocks & messages ----

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

export interface ImageBlock {
  type: 'image'
  attachment: unknown
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

export interface AssistantMessage {
  role: 'assistant'
  content: ContentBlock[]
  finishReason?: unknown
  source?: { kind: string; provider?: string; model?: string }
  id?: string
}

export interface ToolResultMessage {
  role: 'tool'
  source?: { kind: 'tool'; callId?: string }
  content: ContentBlock[]
  isError?: boolean
}

export type StreamChunk =
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name: string; argumentsDelta: string }
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: unknown }
  | { type: 'finish'; reason: unknown }
  | { type: 'unknown-chunk' }

// ---- Mux stream frames ----

export interface MuxEventFrame {
  type: 'session/event'
  sessionId: SessionId
  event: SessionEvent
  view?: unknown
}

export interface MuxSubscribedFrame {
  type: 'session/subscribed'
  sessionId: SessionId
  lastSeq: number
}

export interface MuxProjectionFrame {
  type: 'session/projection'
  sessionId: SessionId
  key: string
  value: unknown
  seq: number
}

export interface ApprovalRequestedFrame {
  type: 'approval/requested'
  sessionId: SessionId
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export interface ApprovalResolvedFrame {
  type: 'approval/resolved'
  sessionId: SessionId
  approvalId: string
  outcome: 'allowed-once' | 'rejected' | string
}

export interface QuestionItem {
  id: string
  question: string
  detail?: string
  header?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
  intent?: { kind: string; approve?: string }
}

export interface QuestionRequestedFrame {
  type: 'question/requested'
  sessionId: SessionId
  questions: QuestionItem[]
}

export interface QuestionResolvedFrame {
  type: 'question/resolved'
  sessionId: SessionId
  questionRpcId: string
  outcome: string
}

export interface SessionQueueFrame {
  type: 'session/queue'
  sessionId: SessionId
  items: unknown[]
}

export interface SessionJobsFrame {
  type: 'session/jobs'
  sessionId: SessionId
  jobs: unknown[]
}

export interface StreamErrorFrame {
  type: 'stream/error'
  error: RpcError
}

export type MuxFrame =
  | MuxEventFrame
  | MuxSubscribedFrame
  | MuxProjectionFrame
  | ApprovalRequestedFrame
  | ApprovalResolvedFrame
  | QuestionRequestedFrame
  | QuestionResolvedFrame
  | SessionQueueFrame
  | SessionJobsFrame
  | StreamErrorFrame
  | { type: string; sessionId?: SessionId; [k: string]: unknown }

export interface HostFrameBase {
  type: string
  [k: string]: unknown
}

export type HostFrame = HostFrameBase

// ---- Responses ----

export interface ApprovalResponsePayload {
  sessionId: SessionId
  approvalId: string
  outcome: 'allowed-once' | 'rejected'
}

export interface QuestionResponsePayload {
  sessionId: SessionId
  answer: {
    answers: { id: string; selected: string[]; custom?: string }[]
  }
}

// ---- Workspace ----

export type WorkspaceId = string

export interface WorkspaceView {
  workspaceId: WorkspaceId
  path: string
  title: string
  sessionIds: SessionId[]
  createdAt: string
  updatedAt: string
}
