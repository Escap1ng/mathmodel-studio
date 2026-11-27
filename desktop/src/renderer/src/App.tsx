import { useEffect, useRef, useState, type JSX } from 'react'
import type {
  DoneData,
  LogData,
  PhaseData,
  ProviderList,
  RunSummary,
  RuntimeStatus
} from '../../shared/api'
import Conversation from './components/Conversation'
import { initialPhases, type LiveRun } from './components/RunView'
import SettingsDialog from './components/SettingsDialog'
import Sidebar from './components/Sidebar'
import Welcome from './components/Welcome'
import {
  conversationTitle,
  loadUi,
  saveUi,
  uid,
  type Conversation as Conv,
  type UiState
} from './lib/store'

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export default function App(): JSX.Element {
  const [ui, setUi] = useState<UiState>(loadUi)
  const [runtime, setRuntime] = useState<RuntimeStatus>({ state: 'starting' })
  const [providers, setProviders] = useState<ProviderList | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [live, setLive] = useState<Record<string, LiveRun>>({})
  const uiRef = useRef(ui)
  uiRef.current = ui

  const activeWorkspace = ui.workspaces.find((item) => item.id === ui.activeWorkspaceId) ?? ui.workspaces[0]
  const activeConversation =
    activeWorkspace?.conversations.find((item) => item.id === ui.activeConversationId) ?? null
  const activeProvider = providers?.providers.find((item) => item.id === providers.activeProvider) ?? null

  useEffect(() => saveUi(ui), [ui])

  useEffect(() => {
    void window.studio.runtime.status().then(setRuntime)
    return window.studio.runtime.onStatus(setRuntime)
  }, [])

  useEffect(() => {
    if (runtime.state !== 'ready') return
    void window.studio.providers.list().then(setProviders).catch(() => undefined)
  }, [runtime.state])

  function patchConversation(convId: string, patch: Partial<Conv>): void {
    setUi((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((workspace) => ({
        ...workspace,
        conversations: workspace.conversations.map((item) =>
          item.id === convId ? { ...item, ...patch } : item
        )
      }))
    }))
  }

  useEffect(() => {
    return window.studio.run.onEvent((payload) => {
      const runId = payload.runId
      let convId: string | null = null
      for (const workspace of uiRef.current.workspaces) {
        const found = workspace.conversations.find((item) => item.runId === runId)
        if (found) {
          convId = found.id
          break
        }
      }
      if (!convId) return

      if (payload.event === 'phase') {
        const data = payload.data as unknown as PhaseData
        setLive((prev) => {
          const run = prev[runId] ?? { phases: initialPhases(), logs: [], progress: '', done: null }
          return {
            ...prev,
            [runId]: {
              ...run,
              phases: { ...run.phases, [data.id]: { label: data.label, status: data.status, detail: data.detail } }
            }
          }
        })
      } else if (payload.event === 'log') {
        const data = payload.data as unknown as LogData
        setLive((prev) => {
          const run = prev[runId] ?? { phases: initialPhases(), logs: [], progress: '', done: null }
          return { ...prev, [runId]: { ...run, logs: [...run.logs.slice(-400), data] } }
        })
      } else if (payload.event === 'progress') {
        const data = payload.data as unknown as { stage?: string; chars?: number }
        if (!data.stage) return
        setLive((prev) => {
          const run = prev[runId] ?? { phases: initialPhases(), logs: [], progress: '', done: null }
          return { ...prev, [runId]: { ...run, progress: `${data.stage} · ${data.chars ?? 0} 字` } }
        })
      } else if (payload.event === 'done') {
        const data = payload.data as unknown as DoneData
        setLive((prev) => {
          const run = prev[runId] ?? { phases: initialPhases(), logs: [], progress: '', done: null }
          return { ...prev, [runId]: { ...run, progress: '', done: data } }
        })
        patchConversation(convId, {
          status: data.ok ? 'done' : 'error',
          outputs: data.outputs,
          picked: data.picked,
          sources: data.sources,
          seconds: data.seconds,
          error: data.error
        })
      }
    })
  }, [])

  useEffect(() => {
    const conversation = activeConversation
    if (!conversation?.runId || conversation.outputs) return
    let alive = true
    void window.studio.run.summary(conversation.runId).then((summary: RunSummary | null) => {
      if (!alive || !summary) return
      patchConversation(conversation.id, {
        status: summary.ok ? 'done' : 'error',
        outputs: summary.outputs,
        picked: summary.picked?.name,
        sources: summary.sources,
        seconds: summary.seconds,
        error: summary.error
      })
    })
    return () => {
      alive = false
    }
  }, [ui.activeConversationId])

  function newConversation(workspaceId?: string, problem = ''): string {
    const conversation: Conv = {
      id: uid('c'),
      title: problem ? conversationTitle(problem) : '新对话',
      problem,
      dataPaths: [],
      status: 'idle',
      createdAt: Date.now()
    }
    setUi((prev) => {
      const target = workspaceId ?? prev.activeWorkspaceId
      return {
        ...prev,
        activeWorkspaceId: target,
        workspaces: prev.workspaces.map((workspace) =>
          workspace.id === target
            ? { ...workspace, conversations: [conversation, ...workspace.conversations] }
            : workspace
        ),
        activeConversationId: conversation.id
      }
    })
    return conversation.id
  }

  function selectConversation(id: string): void {
    const owner = ui.workspaces.find((workspace) => workspace.conversations.some((item) => item.id === id))
    setUi((prev) => ({
      ...prev,
      activeWorkspaceId: owner?.id ?? prev.activeWorkspaceId,
      activeConversationId: id
    }))
  }

  function newWorkspace(): void {
    const workspace = { id: uid('w'), name: `工作区 ${ui.workspaces.length + 1}`, conversations: [] }
    setUi((prev) => ({
      ...prev,
      workspaces: [...prev.workspaces, workspace],
      activeWorkspaceId: workspace.id,
      activeConversationId: null
    }))
  }

  function selectWorkspace(id: string): void {
    const workspace = ui.workspaces.find((item) => item.id === id)
    setUi((prev) => ({
      ...prev,
      activeWorkspaceId: id,
      activeConversationId: workspace?.conversations[0]?.id ?? null
    }))
  }

  function deleteConversation(id: string): void {
    setUi((prev) => ({
      ...prev,
      workspaces: prev.workspaces.map((workspace) => ({
        ...workspace,
        conversations: workspace.conversations.filter((item) => item.id !== id)
      })),
      activeConversationId: prev.activeConversationId === id ? null : prev.activeConversationId
    }))
  }

  async function send(convId: string, problem: string, dataPaths: string[]): Promise<void> {
    if (!activeProvider) return
    try {
      const result = await window.studio.run.start({
        problem,
        dataPaths,
        providerId: activeProvider.id,
        model: activeProvider.model
      })
      patchConversation(convId, {
        problem,
        dataPaths,
        title: problem ? conversationTitle(problem) : '附件建模',
        status: 'running',
        runId: result.runId,
        error: undefined
      })
      setLive((prev) => ({
        ...prev,
        [result.runId]: { phases: initialPhases(), logs: [], progress: '', done: null }
      }))
    } catch (err) {
      patchConversation(convId, { status: 'idle', error: errorText(err) })
    }
  }

  async function cancel(): Promise<void> {
    if (activeConversation?.runId) {
      await window.studio.run.cancel(activeConversation.runId).catch(() => undefined)
    }
  }

  async function openArtifact(path?: string): Promise<void> {
    if (path) await window.studio.artifacts.open(path).catch(() => undefined)
  }

  async function revealArtifact(path?: string): Promise<void> {
    if (path) await window.studio.artifacts.reveal(path).catch(() => undefined)
  }

  return (
    <div className="app">
      <Sidebar
        workspaces={ui.workspaces}
        activeWorkspaceId={activeWorkspace?.id ?? ''}
        activeConversationId={ui.activeConversationId}
        runtime={runtime}
        onSelectWorkspace={selectWorkspace}
        onNewWorkspace={newWorkspace}
        onSelectConversation={selectConversation}
        onNewConversation={(workspaceId) => newConversation(workspaceId)}
        onDeleteConversation={deleteConversation}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main className="main">
        {activeConversation ? (
          <Conversation
            conversation={activeConversation}
            live={activeConversation.runId ? live[activeConversation.runId] : undefined}
            providerLabel={activeProvider ? activeProvider.display : '读取中'}
            runtimeReady={runtime.state === 'ready'}
            onSend={(problem, dataPaths) => void send(activeConversation.id, problem, dataPaths)}
            onCancel={() => void cancel()}
            onOpen={(path) => void openArtifact(path)}
            onReveal={(path) => void revealArtifact(path)}
            onNewConversation={() => newConversation()}
          />
        ) : (
          <Welcome
            onNewConversation={() => newConversation()}
            onExample={(problem) => newConversation(undefined, problem)}
          />
        )}
      </main>
      <SettingsDialog
        open={settingsOpen}
        providers={providers}
        onClose={() => setSettingsOpen(false)}
        onChanged={setProviders}
      />
    </div>
  )
}
