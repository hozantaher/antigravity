// Auth & Account — module contract (binds the UI top-node to the auth/account surface).
//
//   top node      ./ui/LettersAvatar.vue, ./ui/UserMenuAvatar.vue — auto-imported as
//        │        <LettersAvatar>, <UserMenuAvatar> (props/emits are each component's own surface)
//   contract      this file — the auth/account data types the UI + logic bind to
//        │        API surface: /api/auth/* (login, logout, register), /api/me*
//   bottom node   pure auth/account model types, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{useUser,authHeader,state} (auto-imported via
// imports.dirs features/*/logic); server-side server/utils/{firebase,session}.ts +
// server/repos/{userRepo,apiTokenRepo}.ts (stay under server/).
export type { User, RegisterDto, RegisterProfile, Request, ApiTokenRow, ApiTokenCreated } from '~/models'
export { AuthType } from '~/models'
