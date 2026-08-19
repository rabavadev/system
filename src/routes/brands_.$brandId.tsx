import { createFileRoute, getRouteApi, notFound } from '@tanstack/react-router'

import { BrandDetailPage } from '~/features/brands/brand-detail-page'
import { getBrand } from '~/features/brands/server'
import { getBrandNiches } from '~/features/niches/server'

const rootApi = getRouteApi('__root__')

export const Route = createFileRoute('/brands_/$brandId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.brandId)) {
      throw notFound()
    }
    const [brand, nichesData] = await Promise.all([
      getBrand({ data: { id: params.brandId } }),
      getBrandNiches({ data: { brandId: params.brandId } }),
    ])
    if (!brand) {
      throw notFound()
    }
    return { brand, ...nichesData }
  },
  component: BrandDetailRoute,
})

function BrandDetailRoute() {
  const { brand, niches, archivedNiches } = Route.useLoaderData()
  const shell = rootApi.useLoaderData()
  return (
    <BrandDetailPage
      brand={brand}
      niches={niches}
      archivedNiches={archivedNiches}
      isActiveBrand={shell.activeBrand?.id === brand.id}
    />
  )
}
