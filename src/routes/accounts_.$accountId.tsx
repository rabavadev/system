import { createFileRoute, notFound } from '@tanstack/react-router'

import { AccountDetailPage } from '~/features/accounts/account-detail-page'
import { getAccount, getAccountsPageData } from '~/features/accounts/server'

export const Route = createFileRoute('/accounts_/$accountId')({
  loader: async ({ params }) => {
    if (!/^[0-9a-fA-F-]{36}$/.test(params.accountId)) {
      throw notFound()
    }
    const [account, pageData] = await Promise.all([
      getAccount({ data: { id: params.accountId } }),
      getAccountsPageData(),
    ])
    if (!account) {
      throw notFound()
    }
    return {
      account,
      platforms: pageData.platforms,
      brands: pageData.brands,
      nichesByBrand: pageData.nichesByBrand,
    }
  },
  component: AccountDetailRoute,
})

function AccountDetailRoute() {
  const { account, platforms, brands, nichesByBrand } = Route.useLoaderData()
  return (
    <AccountDetailPage
      account={account}
      platforms={platforms}
      brands={brands}
      nichesByBrand={nichesByBrand}
    />
  )
}
