import * as common from './common'
import * as items from './items'
import * as users from './users'
import * as vincario from './vincario'
import * as misc from './misc'
import * as messaging from './messaging'
import * as search from './search'
import * as savedSearches from './saved-searches'
import * as settlement from './settlement'

// Each module self-registers via top-level `registry.register(...)` on evaluation.
// Enumerating the namespaces keeps Nitro/Rollup from tree-shaking these side-effect-only
// modules out of the production build — bare `import './x'` gets dropped, leaving an empty spec.
const SCHEMA_MODULES = [common, items, users, vincario, misc, messaging, search, savedSearches, settlement]

export const registerAllSchemas = (): void => {
  void SCHEMA_MODULES
}
