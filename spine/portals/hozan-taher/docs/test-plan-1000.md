# Comprehensive Test Plan: machinery-outreach (1000 Tests)

**Date:** 2026-04-13  
**Application:** machinery-outreach B2B SaaS (Go backend + React 19 dashboard)  
**Scope:** Unit, integration, E2E, security, performance, accessibility tests

---

## Executive Summary

This document proposes **1000 implementable tests** across 8 categories, targeting:
- Go internal packages (250 tests)
- TypeScript/Vitest utilities (150 tests)
- API integration (200 tests)
- Playwright E2E extending F-specs (200 tests)
- Security/adversarial (80 tests)
- Performance/load (50 tests)
- Accessibility (40 tests)
- Database constraints (30 tests)

---

## 1. GO UNIT TESTS (T001-T240)

### 1.1 Contact Package (40 tests: T001-T040)

| Test ID | Component | Description | Type |
|---------|-----------|-------------|------|
| T001 | contact/store.go | TestCreateContact_ValidEmail | happy-path |
| T002 | contact/store.go | TestCreateContact_DuplicateEmailConflict | error-path |
| T003 | contact/store.go | TestCreateContact_EmptyEmail | boundary |
| T004 | contact/store.go | TestCreateContact_EmailTrimWhitespace | boundary |
| T005 | contact/store.go | TestCreateContact_LongCompanyName_255Chars | boundary |
| T006 | contact/store.go | TestCreateContact_NullableFieldsPreserved | happy-path |
| T007 | contact/store.go | TestCreateContact_TimestampsSet | happy-path |
| T008 | contact/store.go | TestCreateContact_EmailHashGenerated | happy-path |
| T009 | contact/store.go | TestBulkImport_MultipleContacts_AllInserted | happy-path |
| T010 | contact/store.go | TestBulkImport_DuplicatesSkipped_CountReturned | error-path |
| T011 | contact/store.go | TestBulkImport_EmptyList | boundary |
| T012 | contact/store.go | TestBulkImport_MixedValidInvalid_PartialInsert | error-path |
| T013 | contact/store.go | TestBulkImport_TransactionRolledBack_OnError | error-path |
| T014 | contact/store.go | TestFindByID_ExistingContact | happy-path |
| T015 | contact/store.go | TestFindByID_NotFound_ReturnsNil | error-path |
| T016 | contact/store.go | TestFindByID_InvalidID_Negative | boundary |
| T017 | contact/store.go | TestFindByEmail_ByHash | happy-path |
| T018 | contact/store.go | TestFindByEmail_CaseInsensitive | happy-path |
| T019 | contact/store.go | TestFindByEmail_NotFound | error-path |
| T020 | contact/store.go | TestFindByEmail_EmptyEmail | boundary |
| T021 | contact/store.go | TestUpdateStatus_ValidStatus | happy-path |
| T022 | contact/store.go | TestUpdateStatus_InvalidStatus_Rejected | boundary |
| T023 | contact/store.go | TestUpdateStatus_NonexistentContact | error-path |
| T024 | contact/store.go | TestUpdateValidation_ValidResult_StatusComputed | happy-path |
| T025 | contact/store.go | TestUpdateValidation_DisposableMarkedInvalid | happy-path |
| T026 | contact/store.go | TestUpdateValidation_MXCheckFails_Invalid | happy-path |
| T027 | contact/store.go | TestUpdateValidation_JSONMarshalError | error-path |
| T028 | contact/store.go | TestFindBySegment_StatusFilter | happy-path |
| T029 | contact/store.go | TestFindBySegment_RegionFilter | happy-path |
| T030 | contact/store.go | TestFindBySegment_CompanySizeFilter | happy-path |
| T031 | contact/store.go | TestFindBySegment_MultipleFilters_AND | happy-path |
| T032 | contact/store.go | TestFindBySegment_PaginationOffset | happy-path |
| T033 | contact/store.go | TestFindBySegment_PaginationLimit_Enforced | boundary |
| T034 | contact/store.go | TestFindBySegment_EmptyResult | error-path |
| T035 | contact/store.go | TestFindBySegment_NegativeLimit | boundary |
| T036 | contact/store.go | TestFindBySegment_NegativeOffset | boundary |
| T037 | contact/store.go | TestContactModel_EmailHashConsistent | happy-path |
| T038 | contact/store.go | TestContactModel_StatusEnumValues | boundary |
| T039 | contact/store.go | TestContactModel_ScoreBoundary_0to100 | boundary |
| T040 | contact/store.go | TestContactModel_CompanySizeEnums | boundary |

### 1.2 Category Package (35 tests: T041-T075)

[Abbreviated - tests cover: PathToSlug, PathName, ParentPath, AncestorPaths, ListRoots, ListChildren, FindBySlug, FindByPath, EnsureCategory, RefreshCounts, SuppressForCategory, IsSuppressedForCategory]

### 1.3-1.10: Additional Go Packages (T076-T240)

**Company (T076-T105)**: CRUD, AresData, IndustryTags, BulkImport patterns
**Campaign (T106-T130)**: Create, Status transitions, EnrollContacts, Progress metrics
**Thread (T131-T155)**: Create, Status, CurrentStep, ScheduleNextAction, Pause/Resume
**Validation (T156-T175)**: Email syntax, MX, SPF, DKIM, DMARC, caching, rate limiting
**Enrichment (T176-T195)**: EnrichContact, DomainHealth, AresLookup, FirmyCZ, confidence
**ARES (T196-T215)**: LookupByICO, ParseResponse, RateLimiting, SyncJob, ResImport
**Classify (T216-T230)**: JobTitle, Sector, Region, ICP, CategoryMap, NACEMap
**IMAP/Email (T231-T240)**: Connect, FetchEmails, ParseEmail, MarkRead, ContextTimeout

---

## 2. TYPESCRIPT/VITEST UNIT TESTS (T241-T380)

### 2.1 Auth Utilities (T241-T275)

**Session management**: Create, Find, Expire, Refresh, Destroy
**RBAC**: RequireAdmin, RequireOperator, RequireViewer, CanEdit, CanDelete
**Rate Limit**: UnderQuota, OverQuota, ResetWindow, PerIP, PerUser
**TOTP**: Enroll, Verify, BackupCodes, TimeWindow

### 2.2 Data Processing (T276-T310)

**CSV**: Parse, Export, Headers, Quotes, LargeFile, MalformedData
**Email**: Validation, Normalization, PlusSuffix, Edge cases
**Filters**: ContactFilters, CampaignFilters, ThreadFilters, MultipleFilters
**DomainHealth**: Score, MXCheck, SPF, DMARC, Caching
**MagicLink**: Generate, Expiry, Consume, OneTime use
**Migrations**: Sequential, Idempotent, Rollback

### 2.3 Filtering & Analytics (T311-T340)

**FuzzyScore**: ExactMatch, PartialMatch, NoMatch, CaseInsensitive
**Analytics**: FunnelMetrics, TimeSeries, Aggregation, EmptyRange
**Timeline**: Events, FilterByType, Chronological
**AuditLog**: CreatesEntry, UserInfo, Metadata, QueryByUser/Action/DateRange
**Users**: RoleEnum, Creation, PasswordHash, PasswordVerify

### 2.4 Content & Templates (T341-T365)

**EmailTemplate**: BasicVariables, ConditionalBlocks, LoopIterations, HTMLEncoding, XSSPrevention
**Bootstrap**: CreatesFirstUser, SkipsIfExists, InvalidEmail
**ContactPatch**: UpdateStatus, UpdateMultipleFields, InvalidFieldRejected
**ContactExport**: AllColumns, SelectedColumns, EmptyResult
**ThreadPatch**: UpdateStatus, ScheduleNextAction, PauseThread
**Detail pages**: ContactDetail_LoadsFull, CampaignDetail_LoadsMeta, Progress computation

### 2.5 Redis & Caching (T366-T380)

**RedisOps**: Connect, Set/Get, Delete, Expiry, Increment, Hash/List ops
**RedisAdvanced**: Pipelining, Reconnection, PoolExhaustion, Cleanup, Stats

---

## 3. API INTEGRATION TESTS (T381-T580)

### 3.1 Authentication (T381-T410)

- POST /api/auth/login: ValidCredentials, InvalidPassword, NonexistentUser, EmptyFields, RateLimiting
- POST /api/auth/logout: InvalidatesSession, NoSession
- POST /api/auth/2fa/*: Enroll, Confirm (valid/invalid/expired codes), Disable
- GET /api/auth/session: ValidToken, NoToken
- POST /api/auth/refresh: ExtendsExpiry, ExpiredToken
- POST /api/auth/magic-link: SendEmail, UnknownEmail, ConsumeToken (valid/expired/used twice)
- PATCH /api/auth/password: ValidOld, InvalidOld

### 3.2 Contacts CRUD (T411-T445)

- GET /api/contacts: AllContacts, Pagination, Filters (Status/Region), Sort, EmptyResult, RateLimit
- POST /api/contacts: ValidData, DuplicateEmail, InvalidEmail, MissingRequired
- GET /api/contacts/:id: ById, NotFound, InvalidID
- PATCH /api/contacts/:id: Status, MultipleFields, NotFound, InvalidData
- DELETE /api/contacts/:id: Success, NotFound, RequiresAdmin
- POST /api/contacts/import: ValidCSV, InvalidCSV, LargeFile, EmptyFile, ReturnStats
- GET /api/contacts/export: AllColumns, SelectedColumns, WithFilters
- GET /api/contacts/search: ByEmail, ByName, FuzzyMatch
- POST /api/contacts/:id/validate: SyntaxCheck, MXCheck

### 3.3 Campaigns (T446-T484)

- GET /api/campaigns: All, ByStatus, Pagination, EmptyResult
- POST /api/campaigns: DraftStatus, CategoryTargeting, SequenceConfig, InvalidName, EnrollsContacts, RequiresOperator
- GET /api/campaigns/:id: Details, NotFound, IncludesProgress
- PATCH /api/campaigns/:id: Status transitions (Draft→Running, Running→Paused, etc), InvalidTransition, Description, RequiresOperator
- DELETE /api/campaigns/:id: Draft, CannotDeleteRunning, RequiresAdmin
- POST /api/campaigns/:id/enroll: ByCategory, ByFilter, SkipsSuppressed, SkipsUnsubscribed
- GET /api/campaigns/:id/contacts: All, ByStatus, Pagination
- POST /api/campaigns/:id/{start,pause,resume,archive}: StatusTransitions
- POST /api/campaigns/:id/estimate: ReturnsContactCount, IncludesFilters
- GET /api/campaigns/:id/analytics: FunnelMetrics

### 3.4 Threads & Inbox (T485-T514)

- GET /api/threads: All, ByStatus, Pagination
- GET /api/threads/:id: Details, IncludesMessages, NotFound
- PATCH /api/threads/:id: Status, ScheduleNextAction, Pause, CategorySuppress, NotFound
- GET /api/threads/:id/messages: Chronological, Paginated
- POST /api/threads/:id/messages: SendsEmail, StoresInDB, RequiresTemplateOrBody
- GET /api/inbox: UnreadMessages, ByFolder, SearchMessages
- POST /api/inbox/fetch: PollsIMAP, ParsesMessages, ClassifiesReplies
- POST /api/inbox/:id/classify: DetectsReply, DetectsBounce, DetectsOOO
- POST /api/inbox/{:id/mark-read,:id/archive,:id/spam}: UpdatesFolder
- DELETE /api/inbox/:id: Removes
- POST /api/inbox/bulk-action: MarkRead

### 3.5 Admin & Settings (T515-T544)

- GET /api/admin/users: AdminOnly, RequiresAdmin
- POST /api/admin/users: ValidData, InvalidEmail, DuplicateEmail, RequiresAdmin
- PATCH /api/admin/users/:id: Role, Status, RequiresAdmin
- DELETE /api/admin/users/:id: RemovesUser, RequiresAdmin
- GET /api/settings: CurrentUser
- PATCH /api/settings: PreferencesStored
- GET/POST/PATCH/DELETE /api/settings/domains: CRUD, HealthCheck (MX/SPF/DMARC)
- GET/POST/PATCH/DELETE /api/settings/personas: CRUD, RequiresAdmin
- GET /api/audit-log: ReturnsActions, FilterByUser

### 3.6 Analytics & Data (T545-T579)

- GET /api/analytics: FunnelMetrics, TimeSeriesData, DateRangeFilter
- GET /api/analytics/{funnel,timeseries,engagement}: Complete/Partial data, Aggregation levels
- GET /api/stats: ContactCounts, CampaignCounts, DomainStats
- GET /api/companies: All, WithFilters, Details, UpdateIndustry/Category
- GET /api/categories: Roots, Children, SearchByName
- GET /api/suppressions: All, WithFilters, Add/Remove (Email/Domain), BulkImport
- GET /api/system: AllComponents
- GET /api/health: DatabaseConnected, RedisConnected
- GET /api/daemons: AllDaemons, Healthy

---

## 4. PLAYWRIGHT E2E TESTS (T580-T780)

### 4.1 F-Specs Extensions (T580-T640)

**F01-F10**: Contact flow, Campaign wizard, Campaign UI states, Inbox classify, Thread actions, Persona CRUD, User mgmt, Domain health, Score recalc, Analytics filter
**F11-F23**: Error boundary, Company edit, Contact export, Pagination, Suppression bulk, Contact history, RBAC UI, Keyboard a11y, Mobile responsive, Command center, Template render, Prospect nav, Settings config

### 4.2 Core Feature Flows (T641-T705)

**Onboarding**: Login, Magic link, 2FA enrollment
**Workflows**: Import → Campaign → Analytics, Contact → Thread → Reply
**Status flows**: Contact lifecycle, Campaign lifecycle, Thread lifecycle
**UI interactions**: Modals, Toasts, Dropdowns, Context menus, DatePickers, MultiSelect, Tables
**Dashboard**: Layout, Data population, Performance
**Enrichment**: Metrics, Details, Timeline, Suppressions

### 4.3 Cross-Cutting & Advanced (T706-T780)

**Multi-user workflows**: Concurrent operations, Race conditions, Last-write-wins
**Performance**: Page loads, Transitions, Table operations
**Responsive**: Mobile (320px), Tablet (768px), Desktop (1280px)
**Localization**: Czech language, Message translation
**Dark mode**: Toggle, Persistence
**Deep linking**: Campaign/Contact/Thread detail URLs
**Visual regression**: Screenshots
**PDF export**: Reports with charts

---

## 5. SECURITY/ADVERSARIAL TESTS (T780-T860)

### Attack Vectors Covered

**Injection (T780-T805)**
- Login fuzz (empty, SQLi, XSS, long, null bytes)
- Campaign fuzz (name, description, invalid action)
- Contact fuzz (email, name, company, score, status, oversized payload)
- Query injection (search, sort, filter params)
- Header injection (custom, CRLF)

**Authentication & Session (T806-T830)**
- CORS bypass
- CSRF token missing/invalid
- Auth bypass (fake/expired/modified JWT)
- Session fixation/hijack
- Privilege escalation (Viewer→Operator→Admin)

**Authorization (T831-T845)**
- Unauthorized access (admin endpoints, user data, other contacts)
- Information leakage (error messages, stack traces, DB errors, file paths, email validation)
- Broken object level authorization (other user's data)

**Business Logic (T846-T860)**
- Mass assignment (extra fields, status, role)
- Path traversal (file/directory access)
- XML attacks (XXE, bombs)
- Regex DoS
- Timing attacks on password comparison
- Rate limit bypass (fast requests, multiple IPs, X-Forwarded-For spoofing)
- Insecure deserialization (JSON, YAML)
- Upload attacks (malicious files, size limits, MIME mismatch)
- Bomber attacks (bulk requests, large payloads)
- Memory exhaustion (large lists, nested JSON, deep recursion)
- Email spoofing/injection
- Domain squatting
- Open redirects

---

## 6. PERFORMANCE/LOAD TESTS (T861-T910)

### Concurrent Load (T861-T865)
- Contacts API: 1000 concurrent requests
- Campaigns API: 500 concurrent
- Search API: 100 concurrent
- Analytics API: 50 concurrent
- Auth API: 200 concurrent

### Page/List Performance (T866-T870)
- Dashboard: <3s load, <500MB memory
- Contact list: 10K items render, sort/filter in <500ms
- Campaign list: 5K items
- Thread list: 20K items
- Table operations: sort, filter, search under thresholds

### Bulk Operations (T871-T880)
- Bulk import 100K rows: <30s
- Bulk export 100K rows: <30s
- Campaign enrollment 50K contacts: <10s
- Database query complex filter: <500ms
- Database large join (10M rows): <2s
- Redis 1000 keys: <100ms

### System Resources (T881-T890)
- Memory normal: <500MB
- Memory under load: <1GB
- CPU normal: <50%
- CPU under load: <80%
- Disk I/O CSV import 10MB: <5s
- Network latency APIs: <200ms
- Network throughput: >1Mbps
- Connection pooling: exhaustion handled, reuse efficient
- Cache hit rate: >80%
- Cache eviction: LRU correct

### Async/Background (T891-T900)
- Campaign scheduling 10K contacts: distributed
- Email sending 1000/min: sustainable
- IMAP polling 50 mailboxes: concurrent
- WebSocket 100 concurrent connections
- Page transitions: <300ms
- Modal open: <200ms
- Form submit: <300ms
- Bundle size: <1MB

### Web Vitals (T901-T910)
- FCP: <1s
- LCP: <2s
- CLS: <0.1
- TTI: <3s
- Graceful shutdown: in-flight requests completed

---

## 7. ACCESSIBILITY TESTS (T911-T950)

### Images & Icons (T911-T912)
- All images have alt text
- All icons have ARIA labels

### Color & Contrast (T913-T914)
- WCAG AA: 4.5:1 text contrast
- WCAG AAA: 7:1 text contrast
- Not color-alone (patterns/text distinguish)

### Semantic HTML (T915-T925)
- Headings: H1-H6 semantic, correct hierarchy
- Landmarks: Main, Nav, Aside present
- Form labels: All inputs labeled, labels linked
- Form validation: Errors linked and described
- Buttons: Text content, aria-labels

### Keyboard Navigation (T926-T935)
- All interactive elements accessible
- Logical tab order
- Focus visible
- Focus trap in modals
- Clear focus indicator
- Descriptive link text (not "Click here")
- Context clear

### Tables & Lists (T936-T945)
- Table headers marked, scope correct
- Row headers marked
- Semantic UL/OL and LI elements
- Color not alone indicator

### Motion & Interaction (T946-T950)
- Respects prefers-reduced-motion
- Supports 200% zoom level
- Viewport meta present
- Lang attribute set
- Language changes marked
- ARIA live updates
- ARIA roles correct
- ARIA states updated
- Touch targets 44px minimum
- Mobile portrait responsive

---

## 8. DATABASE CONSTRAINT TESTS (T951-T980)

### Schema Constraints (T951-T970)

| Test ID | Table | Constraint | Type |
|---------|-------|-----------|------|
| T951 | contacts | email_hash UNIQUE | regression |
| T952 | contacts | domain_id FK valid | regression |
| T953 | contacts | status enum valid | regression |
| T954 | campaigns | PK required | regression |
| T955 | threads | contact_id FK required | regression |
| T956 | threads | sequence_config JSONB | regression |
| T957 | messages | thread_id FK required | regression |
| T958 | messages | message_id UNIQUE | regression |
| T959 | suppressions | (email OR domain) CHECK | regression |
| T960 | suppressions | email UNIQUE | regression |
| T961 | domains | bounce_rate GENERATED | regression |
| T962 | domains | daily_send_cap default | regression |
| T963 | audit_log | event_type NOT NULL | regression |
| T964 | audit_log | user_id FK valid | regression |
| T965 | operator_audit | action enum | regression |
| T966 | operator_audit | timestamp default | regression |
| T967 | validation | result JSONB | regression |
| T968 | categories | depth computed | regression |
| T969 | categories | slug UNIQUE | regression |
| T970 | categories | roots populated | regression |

### Indices & Performance (T971-T976)

- Index on email_hash exists
- Index on status exists
- Index on created_at exists
- Index on campaign_id exists
- Index on (contact_id, thread_id) exists
- Categories populated (root + child levels)

### Foreign Key Cascades (T977-T980)

- DELETE contact cascades threads
- DELETE thread cascades messages
- DELETE domain cascades contacts
- BulkImport transaction rollback on error

---

## Implementation Notes

### Go Tests
- Extend `contact/store_test.go` pattern using `sqlmock`
- Use table-driven tests for boundary cases
- Mock external services (ARES, FirmyCZ, email validators)

### TypeScript Tests
- Vitest with happy-dom for DOM utilities
- Mock Redis, database connections, external APIs
- Test both sync and async utility functions

### API Integration Tests
- Use `@playwright/test` request context
- Seed test database in setup; cleanup in teardown
- Test both valid and invalid data payloads
- Verify HTTP status codes and response envelopes

### E2E Tests
- Extend existing F-spec patterns (F01-F23)
- Organize by user workflow (not page)
- Test happy path, error cases, edge cases
- Include visual regression with screenshots
- Performance budgets for page load times

### Security Tests
- Replicate monkey.spec.ts patterns
- Cover OWASP Top 10 + 2023 additions
- Verify error responses don't leak internals
- Test rate limiting, input validation, auth boundaries

### Performance Tests
- Use `k6` or `@playwright/test` concurrent mode
- Establish baseline metrics per operation
- Monitor memory, CPU, disk I/O
- Test Web Vitals (FCP, LCP, CLS, TTI)

### Accessibility Tests
- Use `@axe-core/playwright` integration
- Manual WCAG AA/AAA contrast verification
- Test with keyboard only (no mouse)
- Verify screen reader compatibility with ARIA

### Database Tests
- Verify migrations apply correctly
- Test constraints (unique, FK, check)
- Verify indices exist for performance
- Test transaction rollback scenarios

---

## Success Criteria

- **Coverage:** ≥85% Go packages, ≥90% API endpoints
- **Security:** All OWASP vectors tested, no error leakage
- **Performance:** Dashboard <3s, sort/filter <500ms, bulk ops <30s
- **Accessibility:** WCAG 2.1 AA compliance on all pages
- **Reliability:** All tests green, <0.1% flakiness
- **Maintenance:** Clear naming (TestFindUserByEmail_EmptyEmail), reusable helpers

