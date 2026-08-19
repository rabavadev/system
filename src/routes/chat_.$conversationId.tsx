import { createFileRoute, notFound } from '@tanstack/react-router'

import { ChatPage } from '~/features/chat/chat-page'
import { getChatSidebarData, getConversationPageData } from '~/features/chat/server'

export const Route = createFileRoute('/chat_/$conversationId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.conversationId)) {
      throw notFound()
    }
    const [sidebar, active] = await Promise.all([
      getChatSidebarData(),
      getConversationPageData({ data: { id: params.conversationId } }),
    ])
    if (!active) {
      throw notFound()
    }
    return { sidebar, active }
  },
  component: ConversationRoute,
})

function ConversationRoute() {
  const { sidebar, active } = Route.useLoaderData()
  return <ChatPage sidebar={sidebar} active={active} />
}
