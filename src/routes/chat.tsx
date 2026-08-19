import { createFileRoute } from '@tanstack/react-router'

import { ChatPage } from '~/features/chat/chat-page'
import { getChatSidebarData } from '~/features/chat/server'

export const Route = createFileRoute('/chat')({
  loader: () => getChatSidebarData(),
  component: ChatRoute,
})

function ChatRoute() {
  const sidebar = Route.useLoaderData()
  return <ChatPage sidebar={sidebar} />
}
