import { registerAuthPaths } from './auth'
import { registerItemsPaths } from './items'
import { registerReferencePaths } from './reference'
import { registerAccountPaths } from './account'
import { registerDepositPaths } from './deposit'
import { registerAdminPaths } from './admin'
import { registerRecommendationsPaths } from './recommendations'
import { registerMessagingPaths } from './messaging'
import { registerSavedSearchesPaths } from './saved-searches'
import { registerSettlementPaths } from './settlement'

export const registerAllPaths = (): void => {
  registerAuthPaths()
  registerItemsPaths()
  registerReferencePaths()
  registerAccountPaths()
  registerDepositPaths()
  registerAdminPaths()
  registerRecommendationsPaths()
  registerMessagingPaths()
  registerSavedSearchesPaths()
  registerSettlementPaths()
}
