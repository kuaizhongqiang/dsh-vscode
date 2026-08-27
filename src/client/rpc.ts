/**
 * Unary RPC client for the DSH /api channel.
 *
 * Wire protocol (mirrors @deepseek-ai/dsh-client-connection):
 *   POST {base}/api/{method}
 *   body: { "type": "client-request", "rpcId": "<uuid>", "method": "<method>", "payload": {...} }
 *   response JSON: { "type": "server-response", "rpcId": "<same>", "result": { ok:true, value } | { ok:false, error } }
 *
 * Answers to server-requests (approvals / questions) go to POST /api/respond as
 * a client-response echoing the frame's rpcId.
 */

import { randomUUID } from 'node:crypto'
import type {
  ClientRequest,
  ClientResponse,
  RpcResult,
  ServerResponse,
} from './types.ts'

export interface RpcTarget {
  /** Base URL of the DSH web server, e.g. http://127.0.0.1:3080 (no trailing slash). */
  baseUrl: string
  /** Extra headers on every /api request (e.g. Cloudflare Access service token or a session cookie). */
  extraHeaders?: Record<string, string>
}

export class RpcErrorResult extends Error {
  readonly code: string
  readonly details: unknown
  constructor(code: string, message: string, details: unknown) {
    super(message)
    this.name = 'RpcErrorResult'
    this.code = code
    this.details = details
  }
}

export class DshTransportError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'DshTransportError'
    this.status = status
  }
}

/** Normalize a server base URL: strip trailing slashes. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '')
}

export class DshRpcClient {
  private readonly baseUrl: string
  private readonly extraHeaders: Record<string, string>

  constructor(baseUrl: string, extraHeaders: Record<string, string> = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl)
    this.extraHeaders = extraHeaders
  }

  get url(): string {
    return this.baseUrl
  }

  /**
   * Call one unary RPC method. Throws DshTransportError on HTTP/network
   * failure, or RpcErrorResult when the server answered with ok:false.
   */
  async call<T>(method: string, payload: unknown, signal?: AbortSignal): Promise<T> {
    const rpcId = randomUUID()
    const message: ClientRequest = {
      type: 'client-request',
      rpcId,
      method,
      payload,
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.extraHeaders },
        body: JSON.stringify(message),
        signal,
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DshTransportError(`无法连接 DSH 服务 ${this.baseUrl}：${reason}`)
    }
    if (!response.ok) {
      throw new DshTransportError(
        `DSH RPC ${method} 传输失败：HTTP ${response.status}${response.redirected ? '（发生了重定向，可能被访问控制/反代拦截）' : ''}`,
        response.status,
      )
    }
    let envelope: ServerResponse
    try {
      envelope = (await response.json()) as ServerResponse
    } catch {
      const contentType = response.headers.get('content-type') ?? ''
      const hint = contentType.includes('html')
        ? '返回了 HTML（很可能被反向代理 / Cloudflare Access 等访问控制拦截，未放行 /api）'
        : '响应不是合法 JSON'
      throw new DshTransportError(`DSH RPC ${method} ${hint}`)
    }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new DshTransportError(`DSH RPC ${method} 响应 rpcId 不匹配或格式错误`)
    }
    return unwrapResult<T>(method, envelope.result)
  }

  /**
   * Answer a server-request (approval / question). `rpcId` must echo the
   * frame's rpcId; `value` is the domain response payload.
   *
   * The server answers with a receipt `{ accepted: true } | { accepted: false,
   * reason: 'not-pending' | 'bad-response' }`. A rejected receipt (e.g. the
   * request already timed out or was answered by another client) is surfaced as
   * an error — silently swallowing it leaves the agent waiting forever with no
   * feedback (issue #16).
   */
  async respond(rpcId: string, value: unknown): Promise<void> {
    const message: ClientResponse = {
      type: 'client-response',
      rpcId,
      result: { ok: true, value },
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.extraHeaders },
        body: JSON.stringify(message),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new DshTransportError(`无法送达应答到 DSH 服务：${reason}`)
    }
    if (!response.ok) {
      throw new DshTransportError(`应答送达失败：HTTP ${response.status}`)
    }
    try {
      const receipt = (await response.json()) as { accepted?: boolean; reason?: string }
      if (receipt?.accepted === false) {
        const reason = receipt.reason ?? 'unknown'
        const hint = reason === 'not-pending'
          ? '请求已不存在（可能已超时、已被取消，或已被其他端处理）'
          : reason === 'bad-response'
            ? '应答内容未被接受'
            : '未知原因'
        throw new RpcErrorResult('RESPONSE_REJECTED', `DSH 拒绝该应答：${hint}（${reason}）`, { reason })
      }
    } catch (error) {
      if (error instanceof RpcErrorResult) throw error
      // 回执缺失或非 JSON：保持兼容（老版本服务端），不阻断应答送达。
    }
  }
}

export function unwrapResult<T>(method: string, result: RpcResult<unknown>): T {
  if (result.ok) return result.value as T
  throw new RpcErrorResult(result.error.code, result.error.message, result.error.details)
}
