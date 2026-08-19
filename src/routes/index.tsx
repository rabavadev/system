import { createFileRoute } from '@tanstack/react-router'

import { HomePage } from '~/features/home/home-page'
import { getHomeData } from '~/features/home/server'

export const Route = createFileRoute('/')({
  loader: () => getHomeData(),
  component: HomePage,
})
