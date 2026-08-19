import { Files } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function FilesPage() {
  return (
    <FeatureScreen
      icon={Files}
      title="Files"
      description="Assets and documents in this workspace."
      emptyTitle="No files yet"
      emptyDescription="Upload or generate files and they will be organized here."
    />
  )
}
