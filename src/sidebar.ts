/**
 * Sidebar tree: workspaces → sessions (+ an "ungrouped" bucket for sessions
 * that belong to no workspace). Reacts to store changes.
 */

import * as vscode from 'vscode'
import type { SessionStore, StoredSession } from './sessionStore.ts'
import type { SessionId } from './client/types.ts'

type TreeNode =
  | { kind: 'workspace'; workspaceId: string; title: string; path: string; sessions: StoredSession[] }
  | { kind: 'ungrouped'; sessions: StoredSession[] }
  | { kind: 'session'; session: StoredSession }

export class SessionsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private tree: TreeNode[] = []
  private readonly getStore: () => SessionStore | undefined
  private readonly offStore: (() => void) | undefined

  constructor(getStore: () => SessionStore | undefined) {
    this.getStore = getStore
    // The store instance changes across (re)connects, so poll on demand via
    // refresh(); also subscribe to the current store when it appears.
    this.refresh()
  }

  refresh(): void {
    this.rebuild()
  }

  getSessionNode(sessionId: SessionId): TreeNode | undefined {
    for (const node of this.tree) {
      if (node.kind === 'session' && node.session.sessionId === sessionId) return node
    }
    return undefined
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) return this.tree
    if (element.kind === 'workspace') return element.sessions.map(sessionNode)
    if (element.kind === 'ungrouped') return element.sessions.map(sessionNode)
    return []
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'session') return sessionTreeItem(element.session)
    if (element.kind === 'workspace') {
      const item = new vscode.TreeItem(
        element.title || element.path.split(/[\\/]/).pop() || '工作区',
        vscode.TreeItemCollapsibleState.Expanded,
      )
      item.id = `ws:${element.workspaceId}`
      item.iconPath = new vscode.ThemeIcon('folder')
      item.description = `${element.sessions.length} 个会话`
      item.tooltip = new vscode.MarkdownString(
        `**${element.title}**\n\n${element.path}`,
      )
      item.contextValue = 'dsh-workspace'
      return item
    }
    const item = new vscode.TreeItem('未分组会话', vscode.TreeItemCollapsibleState.Expanded)
    item.id = 'ws:__ungrouped__'
    item.iconPath = new vscode.ThemeIcon('inbox')
    item.description = `${element.sessions.length} 个会话`
    item.contextValue = 'dsh-workspace'
    return item
  }

  private rebuild(): void {
    const store = this.getStore()
    const sessions = store?.allSessions ?? []
    const workspaces = store?.allWorkspaces ?? []
    const workspaceIds = new Set(workspaces.map((w) => w.workspaceId))
    // Sessions belonging to no existing workspace.
    const workspaceSessions = new Map<string, StoredSession[]>()
    for (const workspace of workspaces) {
      workspaceSessions.set(workspace.workspaceId, [])
    }
    const ungrouped: StoredSession[] = []
    for (const session of sessions) {
      let placed = false
      for (const workspace of workspaces) {
        if (workspace.sessionIds.includes(session.sessionId)) {
          workspaceSessions.get(workspace.workspaceId)?.push(session)
          placed = true
          break
        }
      }
      if (!placed) ungrouped.push(session)
    }
    void workspaceIds
    this.tree = [
      ...workspaces.map((workspace) => ({
        kind: 'workspace' as const,
        workspaceId: workspace.workspaceId,
        title: workspace.title,
        path: workspace.path,
        sessions: (workspaceSessions.get(workspace.workspaceId) ?? []).sort(byUpdatedAt),
      })),
      ...(ungrouped.length > 0 ? [{ kind: 'ungrouped' as const, sessions: ungrouped.sort(byUpdatedAt) }] : []),
    ]
    this._onDidChangeTreeData.fire(undefined)
  }
}

function sessionNode(session: StoredSession): TreeNode {
  return { kind: 'session', session }
}

function sessionTreeItem(session: StoredSession): vscode.TreeItem {
  const title = session.title ?? '新会话'
  const item = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None)
  item.id = `sess:${session.sessionId}`
  item.iconPath = new vscode.ThemeIcon(
    session.running ? 'loading~spin' : 'comment-discussion',
    session.running ? new vscode.ThemeColor('charts.blue') : undefined,
  )
  const stats: string[] = []
  if (session.running) stats.push('运行中')
  if (session.turns !== undefined) stats.push(`${session.turns} 轮`)
  item.description = stats.join(' · ')
  item.tooltip = new vscode.MarkdownString(
    [
      `**${title}**`,
      '',
      `- 会话: \`${session.sessionId}\``,
      `- 目录: \`${session.cwd}\``,
      `- preset: \`${session.agentPreset}\``,
      session.running ? '- 状态: 🔄 运行中' : '- 状态: 空闲',
    ].join('\n'),
  )
  item.contextValue = 'dsh-session'
  return item
}

function byUpdatedAt(a: StoredSession, b: StoredSession): number {
  return b.updatedAt - a.updatedAt
}
