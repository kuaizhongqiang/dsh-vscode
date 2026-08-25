/**
 * Local DSH service manager: spawns `dsh web` under a configured directory,
 * waits until it answers RPC, and guarantees the child is killed on stop /
 * extension exit (no orphan processes). Powers the "拉起服务" sidebar entry
 * and the local mode of the settings page.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { DshRpcClient } from './client/rpc.ts'

export type LocalServiceStatus = 'stopped' | 'starting' | 'running' | 'failed'

export interface LocalServiceState {
  status: LocalServiceStatus
  /** 子进程 PID（starting / running 时有）。 */
  pid?: number
  /** 服务实际监听端口（就绪后确定）。 */
  port?: number
  /** 服务实际 base URL（就绪后确定）。 */
  url?: string
  /** 最近日志行（环形缓冲，最多 MAX_LOG_LINES 行）。 */
  logs: string[]
  /** 失败原因（status=failed 时）。 */
  error?: string
  /** 启动时使用的目录。 */
  cwd?: string
}

const MAX_LOG_LINES = 80
const READY_TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500
const CALL_TIMEOUT_MS = 2_000
const DEFAULT_URL = 'http://127.0.0.1:3080'
const URL_RE = /https?:\/\/127\.0\.0\.1:\d+/g

export class LocalServerManager {
  private child: ChildProcess | undefined
  private state: LocalServiceState = { status: 'stopped', logs: [] }
  private readonly listeners = new Set<() => void>()
  private readonly extraHeaders: () => Record<string, string>
  private disposed = false

  constructor(extraHeaders: () => Record<string, string>) {
    this.extraHeaders = extraHeaders
  }

  getState(): LocalServiceState {
    return this.state
  }

  onChanged(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Ensure a local `dsh web` process is running under `cwd` and ready to serve
   * RPC. Resolves with the ready base URL. Rejects on spawn failure / timeout.
   */
  async start(cwd: string): Promise<{ url: string }> {
    if (this.state.status === 'running' && this.child !== undefined) {
      return { url: this.state.url ?? DEFAULT_URL }
    }
    if (this.state.status === 'starting') {
      return this.waitUntilReady()
    }
    this.stop()

    this.setState({
      status: 'starting',
      pid: undefined,
      port: undefined,
      url: undefined,
      error: undefined,
      logs: [],
      cwd,
    })
    this.appendLog(`启动本地 DSH 服务：dsh web（cwd=${cwd}）`)

    const isWin = process.platform === 'win32'
    const child = isWin
      ? spawn('dsh.cmd', ['web'], { cwd, shell: true, windowsHide: true })
      : spawn('dsh', ['web'], { cwd, windowsHide: true })

    this.child = child
    this.setState({ ...this.state, pid: child.pid })

    child.stdout?.on('data', (chunk: Buffer) => this.appendLog(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer) => this.appendLog(String(chunk)))
    child.on('error', (error) => {
      this.appendLog(`启动失败：${error.message}`)
      this.fail(`无法启动 dsh 进程：${error.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this.child !== child) return // 已被 stop() 替换
      this.child = undefined
      if (this.state.status === 'starting') {
        this.appendLog(`进程提前退出：code=${code ?? ''} signal=${signal ?? ''}`)
        this.fail(`本地 dsh web 进程提前退出（exit=${code ?? signal ?? 'unknown'}），请检查日志`)
      } else if (this.state.status === 'running') {
        this.appendLog('进程已退出')
        this.setState({ ...this.state, status: 'stopped', pid: undefined, port: undefined, url: undefined })
      }
    })

    try {
      return await this.waitUntilReady()
    } catch (error) {
      // 超时或就绪检查失败：终止进程，避免残留。
      this.killChild()
      throw error
    }
  }

  stop(): void {
    this.killChild()
    this.setState({ ...this.state, status: 'stopped', pid: undefined, port: undefined, url: undefined, error: undefined })
    this.appendLog('本地服务已停止')
  }

  dispose(): void {
    this.disposed = true
    this.killChild()
    this.listeners.clear()
  }

  // ---- Internals ----

  private async waitUntilReady(): Promise<{ url: string }> {
    const deadline = Date.now() + READY_TIMEOUT_MS
    let detectedUrl: string | undefined
    const tryUrls = (): string[] => {
      const urls = new Set<string>()
      if (detectedUrl !== undefined) urls.add(detectedUrl)
      const fromLogs = this.state.logs.join('\n').match(URL_RE)
      for (const m of fromLogs ?? []) urls.add(m)
      urls.add(DEFAULT_URL)
      return [...urls]
    }
    while (Date.now() < deadline) {
      if (this.state.status === 'failed') throw new Error(this.state.error ?? '本地服务启动失败')
      if (this.child === undefined && this.state.status !== 'running') {
        throw new Error(this.state.error ?? '本地 dsh web 进程已退出')
      }
      const urls = tryUrls()
      for (const url of urls) {
        if (await this.ping(url)) {
          this.setState({
            ...this.state,
            status: 'running',
            url,
            port: Number(new URL(url).port),
          })
          this.appendLog(`本地服务就绪：${url}`)
          return { url }
        }
      }
      await sleep(POLL_INTERVAL_MS)
    }
    this.appendLog('等待本地服务就绪超时')
    throw new Error(`本地 dsh web 在 ${READY_TIMEOUT_MS / 1000}s 内未就绪。请检查 dsh.localServerPath 是否正确，以及服务日志。`)
  }

  /** Probe the server with a real RPC call; any HTTP answer counts as up. */
  private async ping(url: string): Promise<boolean> {
    const rpc = new DshRpcClient(url, this.extraHeaders())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
    try {
      await rpc.call<unknown>('host.describe', {}, controller.signal)
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private fail(error: string): void {
    this.setState({ ...this.state, status: 'failed', error })
  }

  private killChild(): void {
    const child = this.child
    this.child = undefined
    if (child === undefined || child.pid === undefined) return
    if (child.exitCode !== null || child.signalCode !== null) return // 已退出
    if (process.platform === 'win32') {
      // Windows 下杀整个进程树，避免残留子进程。
      try {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        return
      } catch {
        // fall through to plain kill
      }
    }
    try {
      child.kill()
    } catch {
      // ignore
    }
  }

  private appendLog(line: string): void {
    const trimmed = line.replace(/\r/g, '').trimEnd()
    if (trimmed.length === 0) return
    const logs = [...this.state.logs, ...trimmed.split('\n')].slice(-MAX_LOG_LINES)
    this.setState({ ...this.state, logs })
  }

  private setState(state: LocalServiceState): void {
    if (this.disposed) return
    this.state = state
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // never let a listener break the manager
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
