import { AtSign } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function AccountsPage() {
  return (
    <FeatureScreen
      icon={AtSign}
      title="Accounts"
      description="Accounts connected to this workspace."
      emptyTitle="No accounts connected"
      emptyDescription="Connect an account to publish and measure through it."
    />
  )
}
