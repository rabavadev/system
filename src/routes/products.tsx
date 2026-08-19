import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { ProductsPage } from '~/features/products/products-page'
import { getProductsPageData } from '~/features/products/server'

const productsSearch = z.object({
  brand: z.string().optional(),
})

export const Route = createFileRoute('/products')({
  validateSearch: (search) => productsSearch.parse(search),
  loaderDeps: ({ search }) => ({ brandId: search.brand }),
  loader: ({ deps }) => getProductsPageData({ data: { brandId: deps.brandId || undefined } }),
  component: ProductsPage,
})
