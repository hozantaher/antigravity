// Design System — module contract (binds the UI top-node to the data bottom-node).
//
//   top node      ./ui/Base*.vue — UI primitives, auto-imported as <BaseInput>, <BaseModal>, …
//        │        (props/emits are each component's own surface)
//   contract      this file — the data types the primitives bind to
//        │
//   bottom node   pure, stateless data structures, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/useValidators (auto-imported via imports.dirs features/*/logic).
export type { default as BaseValidator } from '~/models/BaseValidator'
export type { OptionItem } from '~/models/OptionItem'
export { ModalSize } from '~/models/enums'
