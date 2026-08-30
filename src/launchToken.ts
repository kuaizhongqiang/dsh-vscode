/**
 * Shared DSH launch-token file — `$DSH_HOME/launch-token.json`.
 *
 * dsh v0.1.2+ mints a random process launch token on every `dsh web` start and
 * only prints it to the log; the browser must visit `/?token=<token>` to obtain
 * the 30-day session cookie that authenticates every /api and remote.mux
 * request. dsh-launcher and this extension can each spawn dsh, but each only
 * sees the token in its own child's output — so the token is persisted to a
 * shared file both apps read/write, and the token never needs to be copied by
 * hand between them.
 *
 * Spec (identical on the dsh-launcher side, see `src/tokenFile.ts` there):
 *   path:   $DSH_HOME/launch-token.json   (DSH_HOME default ~/.dsh)
 *   format: { version: 1, token, port?, url, pid?, writtenAt, source }
 * Writer: whoever spawned the running dsh (this extension or the launcher).
 * Reader: the other app (and this app's browser-open path).
 * Cleanup: the writer removes the file when its own child exits, only when the
 * recorded pid matches — never clobbering the other app's record.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from './dshHome.ts'

export const LAUNCH_TOKEN_FILE = 'launch-token.json'
export const LAUNCH_TOKEN_VERSION = 1

export type LaunchTokenSource = 'dsh-vscode' | 'dsh-launcher'

export interface LaunchTokenRecord {
  /** 固定 1；读取方版本不符视为无效。 */
  version: typeof LAUNCH_TOKEN_VERSION
  /** `dsh web` 打印的 `?token=` 值（裸 token）。 */
  token: string
  /** dsh web 监听端口（可选）。 */
  port?: number
  /** 带 token 的规范访问 URL，如 http://127.0.0.1:3080/?token=... */
  url: string
  /** 写入方 spawn 的 dsh 进程 PID（可选，用于清理归属判断）。 */
  pid?: number
  /** 写入时间（ISO 8601）。 */
  writtenAt: string
  /** 写入方：dsh-vscode / dsh-launcher。 */
  source: LaunchTokenSource
}

/** dsh 打印的带 token URL 行，如 `dsh web: http://127.0.0.1:3080/?token=abc...`。 */
export const TOKEN_URL_RE = /(https?:\/\/[^\s"'<>]+?\?token=[A-Za-z0-9_-]+)/g

/** 共享 token 文件的绝对路径。 */
export function launchTokenFilePath(): string {
  return join(dshHome(), LAUNCH_TOKEN_FILE)
}

/** 从一段文本（dsh 子进程日志）提取**最新**一条带 token 的 URL。 */
export function tokenUrlFromLogs(text: string): string | undefined {
  const matches = [...text.matchAll(TOKEN_URL_RE)]
  return matches.length === 0 ? undefined : matches[matches.length - 1]?.[1]
}

/** 从带 token 的 URL 里解析出裸 token（解析失败返回 undefined）。 */
export function tokenFromUrl(url: string): string | undefined {
  try {
    const token = new URL(url).searchParams.get('token')
    return token !== null && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

/** 读取共享 token 文件；缺失 / 损坏 / 版本不符返回 undefined。 */
export function readLaunchToken(): LaunchTokenRecord | undefined {
  try {
    const record = JSON.parse(readFileSync(launchTokenFilePath(), 'utf8')) as LaunchTokenRecord
    if (record.version !== LAUNCH_TOKEN_VERSION) return undefined
    if (typeof record.token !== 'string' || record.token.length === 0) return undefined
    if (typeof record.url !== 'string' || record.url.length === 0) return undefined
    return record
  } catch {
    return undefined
  }
}

/** 写入共享 token 文件（整文件覆盖）。POSIX 权限 0600；失败不抛出（仅降级自动认证）。 */
export function writeLaunchToken(
  record: Omit<LaunchTokenRecord, 'version' | 'writtenAt'>,
): void {
  const full: LaunchTokenRecord = {
    ...record,
    version: LAUNCH_TOKEN_VERSION,
    writtenAt: new Date().toISOString(),
  }
  const path = launchTokenFilePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(full, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
    // 写入失败不致命：调用方继续用日志里的 token，只是对方应用读不到。
  }
}

/**
 * 清理共享 token 文件。仅当文件记录的 pid 与给定 pid 一致（或记录无 pid）时删除，
 * 避免误删另一应用（launcher）维护的记录。
 */
export function clearLaunchToken(pid?: number): void {
  if (pid === undefined) return
  const record = readLaunchToken()
  if (record === undefined) return
  if (record.pid !== undefined && record.pid !== pid) return
  try {
    rmSync(launchTokenFilePath(), { force: true })
  } catch {
    // ignore
  }
}
