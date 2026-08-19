import { useRouter } from '@tanstack/react-router'
import { SendHorizontal } from 'lucide-react'
import { useEffect, useRef, useState, useTransition } from 'react'

import { Button } from '~/components/ui/button'
import { FormError } from '~/components/ui/form'

import { sendMessageFn } from './server'

// Keep in sync with MAX_MESSAGE_CHARS in src/server/db/message.ts. Declared
// locally on purpose: client components never import from server/db, so a
// future cloudflare-only import there cannot leak into the client bundle.
const MAX_MESSAGE_CHARS = 4000
const MAX_HEIGHT = 200
const COUNTER_FROM = MAX_MESSAGE_CHARS - 400

interface ComposerProps {
  conversationId: string
}

/**
 * Message composer foundation. Deliberately no model/agent selectors, file
 * upload, or voice yet — the layout leaves room for a future toolbar row.
 */
export function Composer({ conversationId }: ComposerProps) {
  const router = useRouter()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Focus the composer when a conversation opens (and after each send).
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  function autoGrow() {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, MAX_HEIGHT)}px`
  }

  function send() {
    const content = value.trim()
    if (!content || pending) {
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        await sendMessageFn({ data: { conversationId, content } })
        setValue('')
        const textarea = textareaRef.current
        if (textarea) {
          textarea.style.height = 'auto'
          textarea.focus()
        }
        await router.invalidate()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Could not send the message.')
      }
    })
  }

  return (
    <div className="border-t border-zinc-200 bg-white">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-4">
        <p className="text-[11px] text-zinc-400">
          AI replies aren't connected yet. Your messages are saved.
        </p>
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(event) => {
              setValue(event.target.value)
              autoGrow()
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send()
              }
            }}
            rows={1}
            maxLength={MAX_MESSAGE_CHARS}
            disabled={pending}
            aria-label="Message"
            title="Enter to send, Shift+Enter for a new line"
            placeholder="Write a message…"
            className="max-h-[200px] flex-1 resize-none rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm leading-6 text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none disabled:bg-zinc-50 disabled:text-zinc-400"
          />
          <Button
            onClick={send}
            disabled={pending || value.trim().length === 0}
            aria-label="Send message"
            className="px-3 py-2"
          >
            <SendHorizontal className="size-4" strokeWidth={1.75} />
            Send
          </Button>
        </div>
        <div className="flex items-center justify-between">
          <FormError message={error} />
          {value.length >= COUNTER_FROM && (
            <span className="ml-auto text-[11px] text-zinc-400">
              {value.length}/{MAX_MESSAGE_CHARS}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
