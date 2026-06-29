// Messaging — module contract (binds the public Q&A UI to the question surface).
//
//   top node      ./ui/QuestionThread.vue, ./ui/QuestionRow.vue, ./ui/QuestionForm.vue —
//        │        auto-imported as <QuestionThread>, <QuestionRow>, <QuestionForm>
//   contract      this file — the question data types the UI + logic bind to
//        │        ask API:    POST /api/item/[id]/question
//        │        list API:   GET  /api/item/[id]/questions  (published only)
//        │        admin API:  POST /api/admin/item/[id]/question, GET /api/admin/questions
//   bottom node   the pure Question model type, re-exported here as the module's
//                 contract-tagged subset of the central models/ barrel (decision §7.2)
//
// Behind the contract (swappable impl): logic/{useItemQuestions,useAdminQuestions} (auto-imported
// via imports.dirs features/*/logic); moderation + persistence in questionRepo stay under server/.
export type { Question, QuestionStatus } from '~/models'
