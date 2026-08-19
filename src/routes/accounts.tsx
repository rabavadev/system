import { createFileRoute } from '@tanstack/react-router'

import { AccountsPage } from '~/features/accounts/accounts-page'
import { getAccountsPageData } from '~/features/accounts/server'

export const Route = createFileRoute('/accounts')({
  loader: () => getAccountsPageData(),
  component: AccountsPage,
})
