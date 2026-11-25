import { useEffect, useState, type JSX } from 'react'
import brandIcon from '../../../../build/icon.svg'
import type { RuntimeStatus } from '../../../shared/api'
import type { Workspace } from '../lib/store'

interface Props {
  workspaces: Workspace[]
  activeWorkspaceId: string
  activeConversationId: string | null
  runtime: RuntimeStatus
  onSelectWorkspace: (id: string) => void
  onNewWorkspace: () => void
  onSelectConversation: (id: string) => void
  onNewConversation: (workspaceId: string) => void
  onDeleteConversation: (id: string) => void
  onOpenSettings: () => void
}

function runtimeText(status: RuntimeStatus): string {
  if (status.state === 'ready') return '就绪'
  if (status.state === 'error') return '错误'
  return '启动中'
}

export default function Sidebar(props: Props): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [props.activeWorkspaceId]: true })

  useEffect(() => {
    setExpanded((prev) => ({ ...prev, [props.activeWorkspaceId]: true }))
  }, [props.activeWorkspaceId])

  function toggle(id: string): void {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img className="brand-mark" src={brandIcon} alt="" />
        <span className="brand-name">MathModel Studio</span>
      </div>

      <div className="sidebar-section grow">
        <div className="sidebar-head">
          <span>工作区</span>
          <button className="icon" title="新建工作区" onClick={props.onNewWorkspace}>+</button>
        </div>
        <div className="sidebar-list tree">
          {props.workspaces.map((workspace) => {
            const open = Boolean(expanded[workspace.id])
            return (
              <div className="tree-ws" key={workspace.id}>
                <div className={`ws-row ${workspace.id === props.activeWorkspaceId ? 'active' : ''}`}>
                  <button className="ws-toggle" onClick={() => toggle(workspace.id)} title={open ? '收起' : '展开'}>
                    {open ? '▾' : '▸'}
                  </button>
                  <button className="ws-name" onClick={() => props.onSelectWorkspace(workspace.id)}>
                    {workspace.name}
                  </button>
                  <span className="item-count">{workspace.conversations.length}</span>
                  <button className="icon" title="在此工作区新对话" onClick={() => props.onNewConversation(workspace.id)}>+</button>
                </div>
                {open && (
                  <div className="tree-convs">
                    {workspace.conversations.length === 0 && <p className="sidebar-empty indent">暂无对话</p>}
                    {workspace.conversations.map((conversation) => (
                      <div
                        key={conversation.id}
                        className={`conv-row ${conversation.id === props.activeConversationId ? 'active' : ''}`}
                      >
                        <button className="conv-main" onClick={() => props.onSelectConversation(conversation.id)}>
                          <span className={`status-dot ${conversation.status}`} />
                          <span className="item-name">{conversation.title}</span>
                        </button>
                        <button className="item-x" title="删除对话" onClick={() => props.onDeleteConversation(conversation.id)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      <div className="sidebar-foot">
        <button className="ghost small" onClick={props.onOpenSettings}>设置</button>
        <span className={`pill ${props.runtime.state}`}>{runtimeText(props.runtime)}</span>
      </div>
    </aside>
  )
}
