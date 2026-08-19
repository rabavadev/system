import { useNavigate, useRouter } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { type ReactNode, useTransition } from 'react'

import { Button } from '~/components/ui/button'

import { createConversationFn } from './server'

/** Creates a conversation (scoped to the active brand when one is selected) and opens it. */
export function NewConversationButton({ children }: { children: ReactNode }) {
  const router = useRouter()
  const navigate = useNavigate()
  const [pending, startTransition] = useTransition()

  function create() {
    startTransition(async () => {
      const { id } = await createConversationFn({ data: {} })
      await router.invalidate()
      await navigate({ to: '/chat/$conversationId', params: { conversationId: id } })
    })
  }

  return (
    <Button onClick={create} disabled={pending}>
      <Plus className="size-4" strokeWidth={1.75} />
      {children}
    </Button>
  )
}
