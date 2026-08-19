import { createFileRoute, notFound } from '@tanstack/react-router'

import { ProductDetailPage } from '~/features/products/product-detail-page'
import { getProduct, getProductsPageData } from '~/features/products/server'

export const Route = createFileRoute('/products_/$productId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.productId)) {
      throw notFound()
    }
    const [product, pageData] = await Promise.all([
      getProduct({ data: { id: params.productId } }),
      getProductsPageData({ data: {} }),
    ])
    if (!product) {
      throw notFound()
    }
    return { product, brands: pageData.brands, nichesByBrand: pageData.nichesByBrand }
  },
  component: ProductDetailRoute,
})

function ProductDetailRoute() {
  const { product, brands, nichesByBrand } = Route.useLoaderData()
  return <ProductDetailPage product={product} brands={brands} nichesByBrand={nichesByBrand} />
}
