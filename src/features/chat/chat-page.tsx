import { MessageSquare } from 'lucide-react'

import { EmptyState } from '~/components/ui/empty-state'

import { ConversationSidebar } from './conversation-sidebar'
import { ConversationView } from './conversation-view'
import { NewConversationButton } from './new-conversation-button'
import type { ChatSidebarData, ConversationPageData } from './server'

interface ChatPageProps {
  sidebar: ChatSidebarData
  /** Present on /chat/:conversationId, absent on bare /chat. */
  active?: ConversationPageData
}

export function ChatPage({ sidebar, active }: ChatPageProps) {
  return (
    <div className="flex h-full min-h-0">
      <ConversationSidebar
        conversations={sidebar.conversations}
        archived={sidebar.archivedConversations}
        activeId={active?.conversation.id ?? null}
      />
      {active ? (
        <ConversationView key={active.conversation.id} data={active} />
      ) : (
        <ChatEmpty hasConversations={sidebar.conversations.length > 0} />
      )}
    </div>
  )
}

function ChatEmpty({ hasConversations }: { hasConversations: boolean }) {
  return (
    <section className="flex min-w-0 flex-1 items-center justify-center bg-zinc-50 p-6">
      {hasConversations ? (
        <EmptyState
          icon={MessageSquare}
          title="Pick a conversation"
          description="Choose a conversation on the left, or start a new one."
          action={<NewConversationButton>Start a conversation</NewConversationButton>}
        />
      ) : (
        <EmptyState
          icon={MessageSquare}
          title="No conversations yet"
          description="Conversations are where you brief the workspace. AI replies aren't connected yet, but everything you write is saved."
          action={<NewConversationButton>Start a conversation</NewConversationButton>}
        />
      )}
    </section>
  )
}
