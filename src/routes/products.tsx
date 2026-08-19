import { createFileRoute } from '@tanstack/react-router'

import { ProductsPage } from '~/features/products/products-page'

export const Route = createFileRoute('/products')({
  component: ProductsPage,
})
