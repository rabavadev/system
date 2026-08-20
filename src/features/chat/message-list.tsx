import { Link } from '@tanstack/react-router'
import { AlertCircle, BookmarkPlus, ExternalLink, FlaskConical, Globe } from 'lucide-react'
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

function formatSourceDate(isoString: string | null | undefined): string | null {
  if (!isoString) return null
  try {
    const d = new Date(isoString)
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
  } catch {
    return null
  }
}

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
          let webSearchUsed = false
          let webSearchError: string | null = null

          if (message.providerMetadataJson) {
            try {
              const meta = JSON.parse(message.providerMetadataJson)
              if (Array.isArray(meta?.sources) && meta.sources.length > 0) {
                sources = meta.sources
                webSearchUsed = true
              }
              if (Array.isArray(meta?.toolCalls)) {
                for (const tc of meta.toolCalls) {
                  if (tc?.toolKey === 'web.search') {
                    if (tc.status === 'succeeded') {
                      webSearchUsed = true
                    } else if (tc.status === 'failed' && tc.error) {
                      webSearchError = typeof tc.error === 'string' ? tc.error : 'execution_failed'
                    }
                  }
                }
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
                  {webSearchUsed && (
                    <div className="my-1 inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-medium text-emerald-700 border border-emerald-200/60 w-fit">
                      <Globe className="size-3 text-emerald-600" />
                      <span>Web research used</span>
                    </div>
                  )}

                  <Markdown text={message.content} />

                  {/* Web search error/status notices */}
                  {webSearchError === 'not_configured' && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 p-2.5 text-xs text-amber-800 flex items-start gap-2">
                      <AlertCircle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                      <div className="space-y-0.5">
                        <p className="font-medium">Web search isn’t connected yet.</p>
                        <p className="text-[11px] text-amber-700">
                          Configure your search provider in{' '}
                          <Link
                            to="/settings"
                            className="underline font-medium hover:text-amber-900"
                          >
                            Settings → Tools
                          </Link>{' '}
                          to enable live web research.
                        </p>
                      </div>
                    </div>
                  )}

                  {webSearchError === 'approval_required' && (
                    <div className="mt-2 rounded-md border border-blue-200 bg-blue-50/70 p-2.5 text-xs text-blue-800 flex items-start gap-2">
                      <AlertCircle className="size-4 shrink-0 text-blue-600 mt-0.5" />
                      <div className="space-y-0.5">
                        <p className="font-medium">Web search needs your approval.</p>
                        <p className="text-[11px] text-blue-700">
                          Review pending approval requests in{' '}
                          <Link
                            to="/approvals"
                            className="underline font-medium hover:text-blue-900"
                          >
                            Approvals
                          </Link>{' '}
                          to proceed.
                        </p>
                      </div>
                    </div>
                  )}

                  {webSearchError === 'blocked' && (
                    <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs text-zinc-800 flex items-start gap-2">
                      <AlertCircle className="size-4 shrink-0 text-zinc-500 mt-0.5" />
                      <div className="space-y-0.5">
                        <p className="font-medium">
                          Web search is blocked by your Autonomy settings.
                        </p>
                        <p className="text-[11px] text-zinc-600">
                          Adjust action policies in{' '}
                          <Link
                            to="/settings"
                            className="underline font-medium hover:text-zinc-900"
                          >
                            Settings → Autonomy
                          </Link>
                          .
                        </p>
                      </div>
                    </div>
                  )}

                  {webSearchError === 'rate_limited' && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 p-2.5 text-xs text-amber-800 flex items-start gap-2">
                      <AlertCircle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                      <div className="space-y-0.5">
                        <p className="font-medium">Web search limit reached.</p>
                        <p className="text-[11px] text-amber-700">
                          Please try again later. Answered using existing workspace context.
                        </p>
                      </div>
                    </div>
                  )}

                  {webSearchError === 'timeout' && (
                    <div className="mt-2 rounded-md border border-amber-200 bg-amber-50/70 p-2.5 text-xs text-amber-800 flex items-start gap-2">
                      <AlertCircle className="size-4 shrink-0 text-amber-600 mt-0.5" />
                      <div className="space-y-0.5">
                        <p className="font-medium">Web search took too long to respond.</p>
                        <p className="text-[11px] text-amber-700">
                          Answered using existing workspace context.
                        </p>
                      </div>
                    </div>
                  )}

                  {webSearchError &&
                    ![
                      'not_configured',
                      'approval_required',
                      'blocked',
                      'rate_limited',
                      'timeout',
                    ].includes(webSearchError) && (
                      <div className="mt-2 rounded-md border border-zinc-200 bg-zinc-50 p-2.5 text-xs text-zinc-700 flex items-start gap-2">
                        <AlertCircle className="size-4 shrink-0 text-zinc-500 mt-0.5" />
                        <div className="space-y-0.5">
                          <p className="font-medium">Web search is temporarily unavailable.</p>
                          <p className="text-[11px] text-zinc-600">
                            Answered using existing workspace context.
                          </p>
                        </div>
                      </div>
                    )}

                  {/* Sources List */}
                  {sources.length > 0 ? (
                    <div className="mt-2.5 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 text-xs">
                      <div className="mb-2 flex items-center gap-1.5 font-medium text-zinc-700">
                        <Globe className="size-3.5 text-blue-600" />
                        <span>Sources from web search ({sources.length})</span>
                      </div>
                      <ul className="space-y-1.5">
                        {sources.map((s, idx) => {
                          const pubDate = formatSourceDate(s.publishedAt)
                          return (
                            <li
                              key={`${s.url}::${s.title}`}
                              className="flex items-baseline gap-1.5 text-zinc-700"
                            >
                              <span className="font-mono text-[10px] text-zinc-400">
                                {idx + 1}.
                              </span>
                              <a
                                href={s.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 max-w-md truncate font-medium text-blue-600 hover:text-blue-700 hover:underline"
                              >
                                <span className="truncate">{s.title || s.url}</span>
                                <ExternalLink className="size-2.5 shrink-0 opacity-60" />
                              </a>
                              {s.publisher ? (
                                <span className="text-[11px] text-zinc-500">({s.publisher})</span>
                              ) : null}
                              {pubDate ? (
                                <span className="text-[11px] text-zinc-400">· {pubDate}</span>
                              ) : null}
                            </li>
                          )
                        })}
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
