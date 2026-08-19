import { useNavigate, useRouter } from '@tanstack/react-router'
import { Archive, ArchiveRestore, MessageSquare, Pencil } from 'lucide-react'
import { useEffect, useRef, useState, useTransition } from 'react'

import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { Field, FormError, inputClass } from '~/components/ui/form'
import { Modal } from '~/components/ui/modal'

import { Composer } from './composer'
import { MessageList } from './message-list'
import type { ConversationPageData } from './server'
import { archiveConversationFn, renameConversationFn, restoreConversationFn } from './server'

interface ConversationViewProps {
  data: ConversationPageData
}

export function ConversationView({ data }: ConversationViewProps) {
  const { conversation, messages } = data
  const router = useRouter()
  const navigate = useNavigate()
  const [showRename, setShowRename] = useState(false)
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

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-zinc-50">
      <header className="flex items-center gap-3 border-b border-zinc-200 bg-white px-6 py-3">
        <h1 className="truncate text-sm font-semibold text-zinc-900">
          {conversation.title ?? 'Untitled conversation'}
        </h1>
        {conversation.scopeName && <Badge tone="neutral">{conversation.scopeName}</Badge>}
        {isArchived && <Badge tone="muted">Archived</Badge>}
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
          <div className="flex max-w-sm flex-col items-center gap-2 text-center">
            <div className="flex size-9 items-center justify-center rounded-md bg-zinc-100 text-zinc-500">
              <MessageSquare className="size-4.5" strokeWidth={1.75} />
            </div>
            <h2 className="text-sm font-medium text-zinc-900">No messages yet</h2>
            <p className="text-sm text-zinc-500">
              Write the first message below. AI replies aren't connected yet, but everything you
              send is saved to this conversation.
            </p>
          </div>
        </div>
      ) : (
        <MessageList messages={messages} />
      )}

      {isArchived ? (
        <div className="border-t border-zinc-200 bg-white px-6 py-4 text-center text-xs text-zinc-400">
          This conversation is archived. Restore it to send messages.
        </div>
      ) : (
        <Composer conversationId={conversation.id} />
      )}

      {showRename && (
        <RenameDialog
          conversationId={conversation.id}
          currentTitle={conversation.title ?? ''}
          onClose={() => setShowRename(false)}
        />
      )}
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
            autoFocus
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
