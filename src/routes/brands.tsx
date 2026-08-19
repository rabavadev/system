import { createFileRoute } from '@tanstack/react-router'

import { BrandsPage } from '~/features/brands/brands-page'
import { getBrandsPageData } from '~/features/brands/server'

export const Route = createFileRoute('/brands')({
  loader: () => getBrandsPageData(),
  component: BrandsPage,
})
