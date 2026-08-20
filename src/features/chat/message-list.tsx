import { BookmarkPlus, FlaskConical } from 'lucide-react'
import { useEffect, useRef } from 'react'

import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'
import type { Message, MessageSenderType } from '~/types/domain'

import { Markdown } from './markdown'

const ROLE_LABEL: Record<MessageSenderType, string> = {
  user: 'You',
  agent: 'Assistant',
  system: 'System',
}

// UTC keeps SSR and client hydration identical.
const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
})

interface MessageListProps {
  messages: Message[]
  /** Agent id → display name, so each reply shows WHO answered. */
  agentNames?: Map<string, string>
  /** Agent id → role, to cleanly detect researcher agent messages. */
  agentRoles?: Map<string, string | null>
  savedMessageIds?: Set<string>
  savedResearchMessageIds?: Set<string>
  onSaveToMemory?: (message: Message) => void
  onSaveToResearch?: (message: Message) => void
}

export function MessageList({
  messages,
  agentNames,
  agentRoles,
  savedMessageIds,
  savedResearchMessageIds,
  onSaveToMemory,
  onSaveToResearch,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-6">
        {messages.map((message) => {
          const isResearcherMessage =
            message.senderType === 'agent' &&
            Boolean(
              (message.agentId && agentRoles?.get(message.agentId) === 'researcher') ||
                (message.agentId && agentNames?.get(message.agentId) === 'Researcher'),
            )

          return (
            <article key={message.id} className="flex flex-col gap-1">
              <div className="flex items-baseline gap-2">
                <span
                  className={cn(
                    'text-xs font-semibold',
                    message.senderType === 'user' ? 'text-zinc-900' : 'text-zinc-500',
                  )}
                >
                  {message.senderType === 'agent' && message.agentId
                    ? (agentNames?.get(message.agentId) ?? ROLE_LABEL.agent)
                    : ROLE_LABEL[message.senderType]}
                </span>
                <time dateTime={message.createdAt} className="text-[11px] text-zinc-400">
                  {dateTimeFormat.format(new Date(message.createdAt))}
                </time>
              </div>
              {message.senderType === 'agent' ? (
                <Markdown text={message.content} />
              ) : (
                <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-800">
                  {message.content}
                </p>
              )}
              <div className="flex items-center gap-3">
                {onSaveToMemory && message.senderType !== 'system' ? (
                  <Button
                    variant="ghost"
                    className="px-0 text-xs"
                    onClick={() => onSaveToMemory(message)}
                    aria-label="Save message to Memory"
                  >
                    <BookmarkPlus className="size-3.5" strokeWidth={1.75} />
                    {savedMessageIds?.has(message.id) ? 'Saved to Memory' : 'Save to Memory'}
                  </Button>
                ) : null}
                {onSaveToResearch && isResearcherMessage ? (
                  <Button
                    variant="ghost"
                    className="px-0 text-xs text-blue-600 hover:text-blue-700"
                    onClick={() => onSaveToResearch(message)}
                    aria-label="Save as Research"
                  >
                    <FlaskConical className="size-3.5" strokeWidth={1.75} />
                    {savedResearchMessageIds?.has(message.id)
                      ? 'Saved as Research'
                      : 'Save as Research'}
                  </Button>
                ) : null}
              </div>
            </article>
          )
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
