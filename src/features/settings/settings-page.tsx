import { Settings } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function SettingsPage() {
  return (
    <FeatureScreen
      icon={Settings}
      title="Settings"
      description="Workspace configuration."
      emptyTitle="Nothing to configure yet"
      emptyDescription="Workspace preferences and integrations will be managed here."
    />
  )
}
