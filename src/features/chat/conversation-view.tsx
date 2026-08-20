import { useNavigate, useRouter, useSearch } from '@tanstack/react-router'
import { Archive, ArchiveRestore, Globe, MessageSquare, Pencil } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Loading } from '~/components/ui/loading'
import { Modal } from '~/components/ui/modal'
import { MemoryEditorDialog } from '~/features/memory/memory-editor'
import { getMemoryScopeOptions, type MemoryScopeOptions } from '~/features/memory/server'
import { SaveResearchDialog } from '~/features/research/save-research-dialog'
import type { Message } from '~/types/domain'

import { AgentSelector, resolveSelectedAgent } from './agent-selector'
import { Composer } from './composer'
import { MessageList } from './message-list'
import type { ConversationPageData } from './server'
import { archiveConversationFn, renameConversationFn, restoreConversationFn } from './server'

const RESEARCHER_SUGGESTIONS = [
  'Research this market',
  'Find competitors',
  'Understand this audience',
  'Look for current trends',
  'Research this product opportunity',
]

interface ConversationViewProps {
  data: ConversationPageData
}

export function ConversationView({ data }: ConversationViewProps) {
  const { conversation, messages, agents } = data
  const router = useRouter()
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as { agent?: string }
  // Agent selection is per-send, not per-conversation: the user can switch
  // agents mid-thread and every reply records who actually answered.
  const selectedAgent = useMemo(
    () => resolveSelectedAgent(agents, search.agent),
    [agents, search.agent],
  )
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents])
  const agentRoles = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.role])), [agents])

  function selectAgent(agentId: string) {
    const chief = agents.find((agent) => agent.name === 'Chief' && agent.origin === 'builtin')
    navigate({
      to: '.',
      // Chief is the default; keep the URL clean for it.
      search: chief && agentId === chief.id ? {} : { agent: agentId },
      replace: true,
    })
  }
  const [showRename, setShowRename] = useState(false)
  const [saveMessage, setSaveMessage] = useState<Message | null>(null)
  const [saveResearchMessage, setSaveResearchMessage] = useState<Message | null>(null)
  const [savedResearchMessageIds, setSavedResearchMessageIds] = useState<Set<string>>(new Set())
  const [memoryOptions, setMemoryOptions] = useState<MemoryScopeOptions | null>(null)
  const [memoryOptionsError, setMemoryOptionsError] = useState<string | null>(null)
  const [savedMessageIds, setSavedMessageIds] = useState<Set<string>>(new Set())
  const [composerPrefill, setComposerPrefill] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const isArchived = conversation.deletedAt !== null

  function archive() {
    startTransition(async () => {
      await archiveConversationFn({ data: { id: conversation.id } })
      await router.invalidate()
      await navigate({ to: '/chat' })
    })
  }

  function restore() {
    startTransition(async () => {
      await restoreConversationFn({ data: { id: conversation.id } })
      await router.invalidate()
    })
  }

  function openSaveToMemory(message: Message) {
    setSaveMessage(message)
    setMemoryOptionsError(null)
    if (memoryOptions) return
    getMemoryScopeOptions()
      .then(setMemoryOptions)
      .catch((cause) =>
        setMemoryOptionsError(
          cause instanceof Error ? cause.message : 'Memory choices could not be loaded.',
        ),
      )
  }

  const isResearcherSelected =
    selectedAgent?.role === 'researcher' || selectedAgent?.name === 'Researcher'

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-zinc-50">
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-6 py-3">
        <h1 className="truncate text-sm font-semibold text-zinc-900">
          {conversation.title ?? 'Untitled conversation'}
        </h1>
        {conversation.scopeName && <Badge tone="neutral">{conversation.scopeName}</Badge>}
        {isArchived && <Badge tone="muted">Archived</Badge>}
        {selectedAgent && (
          <AgentSelector
            agents={agents}
            selectedId={selectedAgent.id}
            onChange={selectAgent}
            disabled={isArchived}
          />
        )}
        <div className="ml-auto flex items-center gap-1">
          {isArchived ? (
            <Button variant="secondary" onClick={restore} disabled={pending}>
              <ArchiveRestore className="size-4" strokeWidth={1.75} />
              Restore
            </Button>
          ) : (
            <>
              <Button
                variant="ghost"
                onClick={() => setShowRename(true)}
                aria-label="Rename conversation"
              >
                <Pencil className="size-4" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                onClick={archive}
                disabled={pending}
                aria-label="Archive conversation"
              >
                <Archive className="size-4" strokeWidth={1.75} />
              </Button>
            </>
          )}
        </div>
      </header>

      {messages.length === 0 ? (
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6">
          {isResearcherSelected ? (
            <div className="flex max-w-md flex-col items-center gap-4 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-blue-50 text-blue-600 border border-blue-100 shadow-2xs">
                <Globe className="size-5.5" strokeWidth={1.75} />
              </div>
              <div className="space-y-1">
                <h2 className="text-sm font-semibold text-zinc-900">Start web & market research</h2>
                <p className="text-xs text-zinc-500 max-w-sm">
                  Ask Researcher to investigate market data, competitors, audience trends, or
                  product opportunities.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-center gap-1.5 pt-1">
                {RESEARCHER_SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => setComposerPrefill(suggestion)}
                    className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-700 hover:border-blue-300 hover:bg-blue-50/60 hover:text-blue-700 transition-colors shadow-2xs cursor-pointer"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <div className="flex size-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
                <MessageSquare className="size-4.5" strokeWidth={1.75} />
              </div>
              <h2 className="text-sm font-medium text-zinc-900">No messages yet</h2>
              <p className="text-sm text-zinc-500">
                Write the first message below. {selectedAgent?.name ?? 'Chief'} answers with the
                context of this conversation.
              </p>
            </div>
          )}
        </div>
      ) : (
        <MessageList
          messages={messages}
          agentNames={agentNames}
          agentRoles={agentRoles}
          savedMessageIds={savedMessageIds}
          savedResearchMessageIds={savedResearchMessageIds}
          onSaveToMemory={openSaveToMemory}
          onSaveToResearch={(message) => setSaveResearchMessage(message)}
        />
      )}

      {isArchived ? (
        <div className="border-t border-zinc-200 bg-white px-6 py-4 text-center text-xs text-zinc-400">
          This conversation is archived. Restore it to send messages.
        </div>
      ) : (
        <Composer
          conversationId={conversation.id}
          agentId={selectedAgent?.id ?? null}
          agentName={selectedAgent?.name ?? 'Chief'}
          prefill={composerPrefill}
          onPrefillHandled={() => setComposerPrefill(null)}
        />
      )}

      {showRename && (
        <RenameDialog
          conversationId={conversation.id}
          currentTitle={conversation.title ?? ''}
          onClose={() => setShowRename(false)}
        />
      )}

      {saveResearchMessage && (
        <SaveResearchDialog
          message={saveResearchMessage}
          conversationScope={
            conversation.scopeType && conversation.scopeId
              ? { scopeType: conversation.scopeType, scopeId: conversation.scopeId }
              : undefined
          }
          onClose={() => setSaveResearchMessage(null)}
          onSaved={() =>
            setSavedResearchMessageIds((current) => new Set(current).add(saveResearchMessage.id))
          }
        />
      )}

      {saveMessage ? (
        memoryOptions ? (
          <MemoryEditorDialog
            mode="message"
            scopeOptions={memoryOptions}
            initialContent={saveMessage.content}
            initialClass={
              saveMessage.senderType === 'agent' ? 'proposed_learning' : 'permanent_fact'
            }
            initialScope={
              conversation.scopeType && conversation.scopeId
                ? { scopeType: conversation.scopeType, scopeId: conversation.scopeId }
                : { scopeType: 'workspace', scopeId: null }
            }
            sourceMessageId={saveMessage.id}
            onClose={() => setSaveMessage(null)}
            onSaved={() => setSavedMessageIds((current) => new Set(current).add(saveMessage.id))}
          />
        ) : (
          <Modal title="Save to Memory" onClose={() => setSaveMessage(null)}>
            {memoryOptionsError ? (
              <FormError message={memoryOptionsError} />
            ) : (
              <Loading label="Loading memory choices" />
            )}
          </Modal>
        )
      ) : null}
    </section>
  )
}

interface RenameDialogProps {
  conversationId: string
  currentTitle: string
  onClose: () => void
}

function RenameDialog({ conversationId, currentTitle, onClose }: RenameDialogProps) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState(currentTitle)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Move focus into the dialog when it opens.
  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  function save() {
    setError(null)
    startTransition(async () => {
      try {
        await renameConversationFn({ data: { id: conversationId, title } })
        await router.invalidate()
        onClose()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not rename the conversation.')
      }
    })
  }

  return (
    <Modal title="Rename conversation" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          save()
        }}
        className="flex flex-col gap-3"
      >
        <Field label="Name" htmlFor="rename-conversation">
          <input
            id="rename-conversation"
            ref={inputRef}
            className={inputClass}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
          />
        </Field>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || title.trim().length === 0}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  )
}
