import { Link, useRouter } from '@tanstack/react-router'
import { ArchiveRestore, ChevronDown, MessageSquare } from 'lucide-react'
import { useState, useTransition } from 'react'

import { cn } from '~/lib/utils'
import type { ConversationSummary } from '~/server/db/conversation'
import { NewConversationButton } from './new-conversation-button'
import { restoreConversationFn } from './server'

// UTC keeps SSR and client hydration identical; display conversion is a
// later presentation concern.
const timeFormat = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
})

function activityLabel(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? timeFormat.format(date)
    : dateFormat.format(date)
}

interface ConversationSidebarProps {
  conversations: ConversationSummary[]
  archived: ConversationSummary[]
  activeId: string | null
}

export function ConversationSidebar({
  conversations,
  archived,
  activeId,
}: ConversationSidebarProps) {
  const router = useRouter()
  const [showArchived, setShowArchived] = useState(false)
  const [pending, startTransition] = useTransition()

  function restore(id: string) {
    startTransition(async () => {
      await restoreConversationFn({ data: { id } })
      await router.invalidate()
    })
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-100 px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
          Conversations
        </h2>
        <NewConversationButton>New</NewConversationButton>
      </div>

      <nav aria-label="Conversations" className="flex-1 overflow-y-auto py-1">
        {conversations.map((conversation) => (
          <Link
            key={conversation.id}
            to="/chat/$conversationId"
            params={{ conversationId: conversation.id }}
            className={cn(
              'block px-4 py-2.5 transition-colors hover:bg-zinc-50',
              conversation.id === activeId && 'bg-zinc-100 hover:bg-zinc-100',
            )}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-sm font-medium text-zinc-900">
                {conversation.title ?? 'Untitled conversation'}
              </span>
              <span className="shrink-0 text-[11px] text-zinc-400">
                {activityLabel(conversation.lastActivityAt)}
              </span>
            </div>
            <p className="mt-0.5 truncate text-xs text-zinc-500">
              {conversation.lastMessagePreview ??
                (conversation.scopeName ? `About ${conversation.scopeName}` : 'No messages yet')}
            </p>
          </Link>
        ))}
        {conversations.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-zinc-400">
            <MessageSquare className="size-5" strokeWidth={1.5} />
            <p className="text-xs">Nothing here yet.</p>
          </div>
        )}
      </nav>

      {archived.length > 0 && (
        <div className="border-t border-zinc-100">
          <button
            type="button"
            onClick={() => setShowArchived((value) => !value)}
            aria-expanded={showArchived}
            className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-medium text-zinc-500 transition-colors hover:text-zinc-900"
          >
            Archived ({archived.length})
            <ChevronDown
              className={cn('size-3.5 transition-transform', showArchived && 'rotate-180')}
              strokeWidth={1.75}
            />
          </button>
          {showArchived && (
            <div className="pb-2">
              {archived.map((conversation) => (
                <div
                  key={conversation.id}
                  className="flex items-center justify-between gap-2 px-4 py-1.5"
                >
                  <span className="truncate text-xs text-zinc-400">
                    {conversation.title ?? 'Untitled conversation'}
                  </span>
                  <button
                    type="button"
                    onClick={() => restore(conversation.id)}
                    disabled={pending}
                    aria-label={`Restore ${conversation.title ?? 'conversation'}`}
                    className="shrink-0 rounded p-1 text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700"
                  >
                    <ArchiveRestore className="size-3.5" strokeWidth={1.75} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  )
}
