# Routing Playbook

## Purpose

This playbook tells us how to route work across:

- `Spec Kit`
- `ECC`
- `Agency Agents`

Use it when deciding:

- who owns the current phase
- which supporting skills should be active
- when specialist escalation is necessary
- what the next step should be

## Short Version

- `Spec Kit` owns workflow.
- `ECC` owns execution quality.
- `Agency Agents` provide specialist depth.

If guidance conflicts:

1. follow the spec
2. follow security and safety constraints
3. follow verification and quality gates
4. use specialist advice to optimize within those boundaries

## Phase Owner Map

### Discovery

- **Primary owner**: `Spec Kit`
- **Use for**: shaping the problem, principles, scope, user value
- **Typical next steps**:
  - `$speckit-constitution`
  - `$speckit-specify`
- **Good support**:
  - Agency product and research specialists
  - ECC `market-research`
  - ECC `documentation-lookup`

### Planning

- **Primary owner**: `Spec Kit`
- **Use for**: implementation planning, task breakdown, constraints, rollout shape
- **Typical next steps**:
  - `$speckit-plan`
  - `$speckit-tasks`
- **Good support**:
  - `engineering-software-architect`
  - `design-ux-architect`
  - `engineering-security-engineer`
  - `vitalik-inspired-protocol-architect` for protocol, governance, privacy, and decentralization tradeoffs
  - ECC `api-design`
  - ECC `backend-patterns`
  - ECC `frontend-patterns`
  - ECC `strategic-compact`

### Implementation

- **Primary owner**: `ECC`
- **Use for**: coding discipline, implementation rhythm, structure, reviewability
- **Typical next steps**:
  - execute tasks from `tasks.md`
- **Good support**:
  - ECC `tdd-workflow`
  - ECC `coding-standards`
  - ECC `backend-patterns`
  - ECC `frontend-patterns`
  - Agency engineering specialists by domain

### Review

- **Primary owner**: `ECC`
- **Use for**: verification, consistency, risk reduction, signoff readiness
- **Typical next steps**:
  - verification pass
  - quality and security review
- **Good support**:
  - Codex `reviewer`
  - Codex `docs-researcher`
  - ECC `verification-loop`
  - ECC `security-review`
  - ECC `eval-harness`
  - `engineering-code-reviewer`
  - `testing-reality-checker`
  - `testing-accessibility-auditor`

### Launch

- **Primary owner**: Agency specialists
- **Use for**: GTM, positioning, support readiness, launch execution
- **Typical next steps**:
  - finalize delivery package
  - hand off to the relevant business or launch specialists
- **Good support**:
  - marketing specialists
  - sales specialists
  - support specialists
  - ECC content and research skills when needed

## Default Core Council

Use this by default for non-trivial work:

- `product-manager`
- `engineering-software-architect`
- `design-ux-architect`
- `engineering-security-engineer`
- `testing-reality-checker`
- Codex `reviewer`
- Codex `docs-researcher`
- ECC `verification-loop`

Add `vitalik-inspired-protocol-architect` when the work is protocol-heavy, governance-sensitive, privacy-sensitive, or centered on decentralization tradeoffs.

## Core Council Variants

Use the default council unless the work clearly fits one of these scenario patterns.

### Standard Feature Council

Use when:

- the feature is a normal product or engineering increment
- risk is moderate
- no unusual compliance or launch coordination is required

Council:

- `product-manager`
- `engineering-software-architect`
- `testing-reality-checker`
- Codex `reviewer`
- ECC `verification-loop`

### Complex Feature Council

Use when:

- multiple domains are involved
- architecture and UX both materially matter
- the work has meaningful cross-team coordination risk

Council:

- `product-manager`
- `project-management-project-shepherd`
- `engineering-software-architect`
- `design-ux-architect`
- `engineering-security-engineer`
- `vitalik-inspired-protocol-architect` when protocol or governance tradeoffs are central
- Codex `reviewer`
- Codex `docs-researcher`
- ECC `verification-loop`

### Risky or Regulated Work Council

Use when:

- sensitive data is involved
- external exposure or auth is involved
- policy, legal, or compliance mistakes are expensive

Council:

- `product-manager`
- `engineering-security-engineer`
- `testing-reality-checker`
- `testing-accessibility-auditor`
- `support-legal-compliance-checker`
- `compliance-auditor`
- `vitalik-inspired-protocol-architect` when privacy, identity, coercion resistance, or credible neutrality are core concerns
- Codex `docs-researcher`
- ECC `security-review`
- ECC `verification-loop`

### Launch and GTM Council

Use when:

- the work is ready for release planning
- messaging, discoverability, or support readiness matter
- cross-functional delivery is part of success

Council:

- `product-manager`
- `project-management-project-shepherd`
- `support-analytics-reporter`
- `marketing-ai-citation-strategist`
- `marketing-seo-specialist`
- `sales-outbound-strategist`
- ECC `documentation-lookup`
- ECC `verification-loop`

## Escalation Rules

Add specialists only when the work justifies it.

### Escalate to design specialists when

- user experience is central to success
- the surface is customer-facing
- information architecture or visual clarity matters

### Escalate to security or compliance specialists when

- auth, sensitive data, external integrations, or policy constraints are involved
- the cost of a mistake is high

### Escalate to protocol-governance specialists when

- the design includes blockchain or cryptoeconomic mechanisms
- decentralization, privacy, or governance tradeoffs are part of the core decision
- identity, coercion resistance, or credible neutrality materially affect the architecture

### Escalate to GTM specialists when

- the work affects launch, messaging, discoverability, or channel execution

### Escalate to accessibility specialists when

- the feature affects interaction, navigation, forms, or reading flows

## Escalation Matrix

| Trigger | Add | Why |
|---|---|---|
| Sensitive auth or user data | `engineering-security-engineer`, ECC `security-review` | Protects high-cost risk areas |
| Regulated or policy-sensitive work | `support-legal-compliance-checker`, `compliance-auditor` | Prevents avoidable governance failures |
| Protocol, governance, or decentralization tradeoffs | `vitalik-inspired-protocol-architect` | Adds first-principles analysis for mechanism design, privacy, and social-layer dependencies |
| UX-critical customer flow | `design-ux-architect`, `design-ui-designer` | Improves usability and clarity where design matters materially |
| Accessibility-sensitive interaction | `testing-accessibility-auditor` | Reduces accessibility regressions before release |
| Cross-functional launch | GTM and support specialists | Aligns delivery, messaging, and readiness |
| Multi-domain architectural complexity | `project-management-project-shepherd`, `engineering-software-architect`, Codex `docs-researcher` | Keeps coordination and technical reasoning aligned |

## Conflict Resolution

Use this section when guidance from Spec Kit, ECC, and Agency specialists does not fully align.

### Decision Order

Apply this order strictly:

1. **Spec artifacts**
2. **Security and safety constraints**
3. **Verification and quality gates**
4. **Specialist optimization advice**

### Conflict Matrix

| Conflict | Winner | What to do |
|---|---|---|
| Specialist recommendation vs agreed spec | Spec artifacts | Update the spec first if the specialist is right; do not silently drift |
| Fastest implementation path vs ECC verification requirement | Verification and quality gates | Keep the verification step and reduce scope if needed |
| Delivery pressure vs security concern | Security and safety constraints | Stop and resolve the security concern before shipping |
| Launch urgency vs incomplete validation | Verification and quality gates | Delay release or reduce scope until the validation bar is met |
| Two specialists disagree on optimization | Spec first, then owner judgment | Return to the work item goal, phase owner, and explicit constraints |
| Planning guidance vs implementation convenience | Spec Kit plan | Change the plan deliberately or follow it as written |

### Conflict Handling Procedure

When a conflict appears:

1. Name the conflict clearly.
2. Identify which guidance sources are involved.
3. Apply the precedence order.
4. Record the chosen rule in the routing decision record.
5. If the chosen outcome materially changes scope or intent, update the relevant spec artifact.

### Red Flags

Stop and re-evaluate if:

- a contributor wants to bypass verification for speed
- a specialist suggestion changes user value but the spec is not updated
- launch planning begins before the work is actually review-ready
- two councils are being combined without a clear primary owner

## Routing Decision Record

For important work items, capture at least:

- **Work Item Title**
- **Work Item Summary**
- **Current Phase**
- **Primary Owner**
- **Support Roles**
- **Core Council**
- **Escalation Triggers**
- **Precedence Rule Applied**
- **Next Action**

Reference contract:

- [routing-decision-contract.md](/Users/messingtomas/Taher/hozan-taher/specs/001-stack-routing-playbook/contracts/routing-decision-contract.md)

## Quick Routing Examples

### Example 1: New feature idea with unclear scope

- **Primary owner**: `Spec Kit`
- **Support**: product, research, UX specialists
- **Next action**: `$speckit-specify`

### Example 2: Active coding task with known scope

- **Primary owner**: `ECC`
- **Support**: engineering specialist for the domain
- **Council**: Standard Feature Council
- **Next action**: implement the next `tasks.md` item with ECC execution skills

### Example 3: Auth-related feature with user-facing UI

- **Primary owner**: `Spec Kit` during planning, `ECC` during build/review
- **Council**: Risky or Regulated Work Council with design escalation
- **Support**:
  - `engineering-security-engineer`
  - `design-ux-architect`
  - `testing-accessibility-auditor`
- **Next action**: plan the feature first, then implement under ECC discipline

### Example 4: Release and launch coordination

- **Primary owner**: Agency launch/GTM specialists
- **Council**: Launch and GTM Council
- **Support**: ECC verification and documentation skills
- **Next action**: verify the feature is complete, then hand off to launch-oriented specialists

### Example 5: Specialist wants a better design but it changes scope

- **Primary owner**: `Spec Kit` if the scope must change, otherwise current phase owner
- **Conflict**: specialist optimization vs agreed scope
- **Winner**: spec artifacts
- **Next action**: either keep the current scope or update the spec deliberately before changing direction

## Recommended Default Flow

1. Define or refine principles.
2. Create the spec.
3. Produce the plan.
4. Generate tasks.
5. Build with ECC.
6. Review with ECC plus targeted specialists.
7. Launch with the appropriate Agency roles.

## Practical Rule

When in doubt:

- start with `Spec Kit`
- execute with `ECC`
- escalate with `Agency`
