import { BookmarkPlus, FlaskConical, Globe } from 'lucide-react'
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

          let sources: Array<{
            title: string
            url: string
            publisher?: string | null
            publishedAt?: string | null
          }> = []
          if (message.providerMetadataJson) {
            try {
              const meta = JSON.parse(message.providerMetadataJson)
              if (Array.isArray(meta?.sources) && meta.sources.length > 0) {
                sources = meta.sources
              }
            } catch {
              // ignore malformed JSON
            }
          }

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
                <>
                  <Markdown text={message.content} />
                  {sources.length > 0 ? (
                    <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50/50 p-2.5 text-xs">
                      <div className="mb-1.5 flex items-center gap-1.5 font-medium text-zinc-600">
                        <Globe className="size-3.5 text-zinc-500" />
                        <span>Sources ({sources.length})</span>
                      </div>
                      <ul className="space-y-1">
                        {sources.map((s, idx) => (
                          <li
                            key={`${s.url}::${s.title}`}
                            className="flex items-baseline gap-1.5 text-zinc-700"
                          >
                            <span className="font-mono text-[10px] text-zinc-400">{idx + 1}.</span>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-block max-w-md truncate font-medium text-blue-600 hover:text-blue-700 hover:underline"
                            >
                              {s.title || s.url}
                            </a>
                            {s.publisher ? (
                              <span className="text-[11px] text-zinc-400">({s.publisher})</span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
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
