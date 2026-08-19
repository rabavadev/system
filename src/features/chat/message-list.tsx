import { useEffect, useRef } from 'react'

import { cn } from '~/lib/utils'
import type { Message, MessageSenderType } from '~/types/domain'

import { Markdown } from './markdown'

const ROLE_LABEL: Record<MessageSenderType, string> = {
  user: 'You',
  agent: 'Chief',
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
}

export function MessageList({ messages }: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when new messages arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-6">
        {messages.map((message) => (
          <article key={message.id} className="flex flex-col gap-1">
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  'text-xs font-semibold',
                  message.senderType === 'user' ? 'text-zinc-900' : 'text-zinc-500',
                )}
              >
                {ROLE_LABEL[message.senderType]}
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
          </article>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
