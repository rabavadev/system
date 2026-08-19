import { MessageSquare } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function ChatPage() {
  return (
    <FeatureScreen
      icon={MessageSquare}
      title="Chat"
      description="Talk to Chief and your agents."
      emptyTitle="No conversations yet"
      emptyDescription="Start a conversation to brief Chief or ask an agent for help."
    />
  )
}
