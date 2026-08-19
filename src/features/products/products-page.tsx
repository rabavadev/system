import { Package } from 'lucide-react'

import { FeatureScreen } from '~/components/layout/feature-screen'

export function ProductsPage() {
  return (
    <FeatureScreen
      icon={Package}
      title="Products"
      description="The products you promote."
      emptyTitle="No products yet"
      emptyDescription="Add a product to organize content, research, and campaigns around it."
    />
  )
}
