/**
 * Standalone smoke test for the DSH protocol client (not part of the VSIX).
 * Run: node --experimental-strip-types scripts/smoke.mts http://127.0.0.1:3080
 */
import { DshConnection } from '../src/client/connection.ts'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3080'
const results: string[] = []

function check(name: string, ok: boolean, detail = ''): void {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  const connection = new DshConnection(baseUrl, { reconnectIntervalMs: 1000 })

  // 1. Unary RPC: host.describe
  try {
    const describe = await connection.rpc.call<unknown>('host.describe', {})
    check('host.describe', typeof describe === 'object' && describe !== null)
  } catch (error) {
    check('host.describe', false, String(error))
  }

  // 2. Unary RPC: session.list
  let sessions: { sessionId: string; running: boolean }[] = []
  try {
    sessions = await connection.listSessions()
    check('session.list', sessions.length >= 0, `${sessions.length} 个会话`)
  } catch (error) {
    check('session.list', false, String(error))
  }

  // 3. history of the first session
  if (sessions.length > 0) {
    const sid = sessions[0]!.sessionId
    try {
      const history = await connection.history(sid, 5)
      check('session.history', history.events.length > 0, `${history.events.length} 事件`)
    } catch (error) {
      check('session.history', false, String(error))
    }
    try {
      const models = await connection.models(sid)
      check('session.models', typeof models.routable === 'boolean' && Array.isArray(models.groups),
        `routable=${models.routable}, ${models.groups.length} 组`)
    } catch (error) {
      check('session.models', false, String(error))
    }
  } else {
    check('session.history', false, '无会话可测')
  }

  // 3b. agent preset catalog (read-only)
  try {
    const presets = await connection.listPresets()
    check('agentPreset.list', Array.isArray(presets), `${presets.length} 个 preset`)
  } catch (error) {
    check('agentPreset.list', false, String(error))
  }

  // 4. Mux stream: connect, expect session/event or projection frames within 6s
  const frames: string[] = []
  const off = connection.onEvent((event) => {
    if (event.kind === 'session-event' || event.kind === 'projection' || event.kind === 'host-frame') {
      frames.push(event.kind)
    }
  })
  try {
    await connection.connect()
    // Wait for the WebSocket to actually open (async).
    const deadline = Date.now() + 5000
    while (!connection.connected && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    check('connect (host.describe verify)', connection.connected, `mux connected=${connection.connected}`)
  } catch (error) {
    check('connect', false, String(error))
  }
  await new Promise((resolve) => setTimeout(resolve, 6000))
  check('mux frames received', frames.length > 0, `${frames.length} 帧（${frames.slice(0, 5).join(',')}…）`)
  off()
  connection.dispose()

  console.log(results.join('\n'))
  const failed = results.some((r) => r.startsWith('FAIL'))
  process.exit(failed ? 1 : 0)
}

void main().catch((error) => {
  console.error(error)
  process.exit(1)
})
