/**
 * DSH browser-session authentication.
 *
 * The current DSH requires a browser-session cookie on every /api request and
 * on the /api/remote.mux WebSocket handshake. That cookie can only be minted by
 * exchanging the Host's process launch token against the index route:
 *
 *   GET {base}/?token=<launchToken>   →  303 with Set-Cookie: dsh-auth-<hash>=v1...
 *
 * This module performs the exchange once, then exposes the cookie value so it
 * can be attached to every /api fetch and the WebSocket handshake. Clients that
 * don't need authentication (e.g. an already-unlocked local server) may skip
 * the exchange.
 */

export interface AuthExchangeResult {
  /** Raw cookie header value, e.g. `dsh-auth-<hash>=v1...`. Empty when unauthenticated. */
  readonly cookie: string
  /** Final base URL after any redirect (typically unchanged). */
  readonly baseUrl: string
}

/** Parse `Set-Cookie` header(s) into name=value pairs (first wins). */
function parseSetCookies(value: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (value == null) return out
  for (const part of value.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const name = part.slice(0, eq).trim()
    const valuePart = part.slice(eq + 1).split(';')[0]!.trim()
    if (name.length > 0 && !out.has(name)) out.set(name, valuePart)
  }
  return out
}

/**
 * Exchange a process launch token for the browser-session cookie.
 *
 * @param baseUrl - DSH web origin (no trailing slash).
 * @param token   - the process launch token printed by `dsh web`.
 * @param extraHeaders - extra headers to carry on the request.
 * @throws Error when the exchange cannot be completed.
 */
export async function authenticateWithToken(
  baseUrl: string,
  token: string,
  extraHeaders: Record<string, string> = {},
): Promise<AuthExchangeResult> {
  const trimmed = token.trim()
  if (trimmed.length === 0) {
    return { cookie: '', baseUrl }
  }
  const url = `${baseUrl}/?token=${encodeURIComponent(trimmed)}`
  let response: Response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { ...extraHeaders },
      redirect: 'manual',
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`无法连接 DSH 服务 ${baseUrl} 以换取认证 cookie：${reason}`)
  }
  if (response.status !== 303 && response.status !== 302) {
    // A direct 200 means the route didn't require auth (no token gate active).
    if (response.status === 200) return { cookie: '', baseUrl }
    throw new Error(`DSH 认证 cookie 换取失败：HTTP ${response.status}`)
  }
  const cookies = parseSetCookies(response.headers.get('set-cookie'))
  const authCookie = [...cookies.entries()].find(([name]) => name.startsWith('dsh-auth-'))
  if (authCookie === undefined) {
    // Some deployments reject the token on the root route; surface the status.
    throw new Error(`DSH 认证成功但未返回会话 cookie（HTTP ${response.status}）`)
  }
  return { cookie: `${authCookie[0]}=${authCookie[1]}`, baseUrl }
}
