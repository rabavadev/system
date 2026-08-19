import { createServerFn } from '@tanstack/react-start'

import { listAccounts } from '~/server/db/account'
import { listBrands } from '~/server/db/brand'
import { listProducts } from '~/server/db/product'
import { getDefaultWorkspace } from '~/server/db/workspace'

export interface HomeData {
  brandCount: number
  productCount: number
  accountCount: number
}

/** Real counts for the home overview. No analytics, just structure. */
export const getHomeData = createServerFn({ method: 'GET' }).handler(
  async (): Promise<HomeData> => {
    const workspace = await getDefaultWorkspace()
    if (!workspace) {
      return { brandCount: 0, productCount: 0, accountCount: 0 }
    }
    const [brands, products, accounts] = await Promise.all([
      listBrands(workspace.id),
      listProducts(workspace.id),
      listAccounts(workspace.id),
    ])
    return {
      brandCount: brands.length,
      productCount: products.length,
      accountCount: accounts.length,
    }
  },
)
