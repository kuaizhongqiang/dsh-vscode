import { describe, expect, it, vi, afterEach } from 'vitest'
import { DshRpcClient, DshTransportError, RpcErrorResult, normalizeBaseUrl } from './rpc.ts'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and whitespace', () => {
    expect(normalizeBaseUrl(' http://127.0.0.1:3080/// ')).toBe('http://127.0.0.1:3080')
  })
})

describe('DshRpcClient.call', () => {
  it('posts a client-request envelope and unwraps ok results', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.type).toBe('client-request')
      expect(body.method).toBe('session.list')
      expect(body.payload).toEqual({})
      expect(String(input)).toMatch(/\/api\/session\.list$/)
      return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: { items: [] } } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    const value = await client.call<{ items: unknown[] }>('session.list', {})
    expect(value.items).toEqual([])
  })

  it('throws RpcErrorResult on ok:false', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      return jsonResponse({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: false, error: { code: 'session-not-found', message: 'no such session', details: {} } },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session.history', { sessionId: 'x' })).rejects.toMatchObject({
      code: 'session-not-found',
      message: 'no such session',
    })
  })

  it('rejects on rpcId mismatch', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ type: 'server-response', rpcId: 'other', result: { ok: true, value: null } }))
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session.list', {})).rejects.toThrow(/rpcId/)
  })

  it('throws DshTransportError on HTTP error and network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('forbidden', { status: 403 })))
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await expect(client.call('session.list', {})).rejects.toBeInstanceOf(DshTransportError)

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(client.call('session.list', {})).rejects.toBeInstanceOf(DshTransportError)
  })
})

describe('DshRpcClient.respond', () => {
  it('posts a client-response echoing the rpcId', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      expect(body.type).toBe('client-response')
      expect(body.rpcId).toBe('rpc-1')
      expect(body.result).toEqual({
        ok: true,
        value: { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' },
      })
      return jsonResponse({ accepted: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    const client = new DshRpcClient('http://127.0.0.1:3080')
    await client.respond('rpc-1', { sessionId: 's1', approvalId: 'a1', outcome: 'allowed-once' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('RpcErrorResult', () => {
  it('carries code and details', () => {
    const error = new RpcErrorResult('agent-busy', 'busy', { reason: 'running' })
    expect(error.code).toBe('agent-busy')
    expect(error.details).toEqual({ reason: 'running' })
  })
})
