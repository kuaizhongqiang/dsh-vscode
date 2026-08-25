/**
 * Mux event stream client: a WebSocket to {base}/api/events.mux.
 *
 * The server pushes JSON server-request envelopes whose payload is a MuxFrame
 * (session/event, session/subscribed, session/projection, approval/requested,
 * question/requested, session/jobs, …). This client reconnects with backoff
 * and dispatches parsed frames to listeners.
 */

import type { MuxFrame, ServerRequest } from './types.ts'

export interface MuxStreamCallbacks {
  onOpen?: () => void
  onClose?: (reason: string) => void
  onError?: (error: unknown) => void
  onFrame?: (rpcId: string, frame: MuxFrame) => void
}

export interface MuxStreamOptions {
  baseUrl: string
  /** Reconnect interval after an unexpected close (ms). */
  reconnectIntervalMs?: number
  /** Max consecutive reconnect attempts before giving up (0 = unlimited). */
  maxReconnects?: number
}

const SOCKET_CLOSED_BY_US = 4000

export class MuxStreamClient {
  private readonly baseUrl: string
  private readonly reconnectIntervalMs: number
  private readonly maxReconnects: number
  private readonly callbacks: MuxStreamCallbacks
  private socket: WebSocket | undefined
  private closedByUs = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private aborted = false

  constructor(options: MuxStreamOptions, callbacks: MuxStreamCallbacks = {}) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 3000
    this.maxReconnects = options.maxReconnects ?? 0
    this.callbacks = callbacks
  }

  get connected(): boolean {
    return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN
  }

  connect(): void {
    if (this.socket !== undefined && this.socket.readyState === WebSocket.OPEN) return
    this.closedByUs = false
    this.openSocket()
  }

  /** Close for good; stops reconnecting. */
  close(): void {
    this.aborted = true
    this.closedByUs = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.socket !== undefined) {
      try {
        this.socket.close(SOCKET_CLOSED_BY_US, 'client closed')
      } catch {
        // already gone
      }
      this.socket = undefined
    }
  }

  private openSocket(): void {
    if (this.aborted) return
    const url = new URL('/api/events.mux', this.baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    let socket: WebSocket
    try {
      socket = new WebSocket(url)
    } catch (error) {
      this.emitError(error)
      return
    }
    this.socket = socket

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0
      this.callbacks.onOpen?.()
    })

    socket.addEventListener('message', (event: MessageEvent) => {
      let envelope: ServerRequest
      try {
        if (typeof event.data !== 'string') return
        envelope = JSON.parse(event.data) as ServerRequest
      } catch {
        return // malformed frame — drop
      }
      if (envelope.type !== 'server-request') return
      this.callbacks.onFrame?.(envelope.rpcId, envelope.payload as MuxFrame)
    })

    socket.addEventListener('close', (event: CloseEvent) => {
      if (this.socket === socket) this.socket = undefined
      this.callbacks.onClose?.(event.reason || `code ${event.code}`)
      if (!this.closedByUs && !this.aborted) this.scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      // 'close' always follows 'error'; the close handler owns recovery.
    })
  }

  private scheduleReconnect(): void {
    if (this.aborted) return
    if (this.maxReconnects > 0 && this.reconnectAttempts >= this.maxReconnects) {
      this.emitError(new Error(`事件流重连失败（已达 ${this.maxReconnects} 次上限）`))
      return
    }
    this.reconnectAttempts += 1
    this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectIntervalMs)
  }

  private emitError(error: unknown): void {
    this.callbacks.onError?.(error)
  }
}
