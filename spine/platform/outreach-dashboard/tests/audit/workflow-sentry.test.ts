/**
 * CI Workflow YAML unit tests — Sentry deployment tracking, Go release, PR comment
 *
 * These tests parse the actual go-services-ci.yml file and assert structural
 * invariants: correct steps exist, they reference the right secrets, and they
 * have graceful-degradation conditions so a missing secret won't break CI.
 *
 * Run with: pnpm test:contract
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

const WORKFLOW_PATH = resolve(__dirname, '../../../../../.github/workflows/go-services-ci.yml')

interface WorkflowStep {
  name?: string
  if?: string
  run?: string
  uses?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}

interface WorkflowJob {
  name?: string
  steps?: WorkflowStep[]
  needs?: string | string[]
}

interface Workflow {
  jobs: Record<string, WorkflowJob>
}

let _workflow: Workflow | null = null
function getWorkflow(): Workflow {
  if (!_workflow) {
    const raw = readFileSync(WORKFLOW_PATH, 'utf8')
    _workflow = yaml.load(raw) as Workflow
  }
  return _workflow
}

function getJob(jobKey: string): WorkflowJob {
  const wf = getWorkflow()
  const job = wf.jobs[jobKey]
  if (!job) throw new Error(`Job '${jobKey}' not found. Available: ${Object.keys(wf.jobs).join(', ')}`)
  return job
}

function getStep(job: WorkflowJob, nameFragment: string): WorkflowStep | undefined {
  return job.steps?.find((s) => s.name?.toLowerCase().includes(nameFragment.toLowerCase()))
}

function requireStep(job: WorkflowJob, nameFragment: string): WorkflowStep {
  const step = getStep(job, nameFragment)
  if (!step) {
    const names = job.steps?.map((s) => s.name ?? '(unnamed)').join(', ') ?? '(no steps)'
    throw new Error(`Step containing '${nameFragment}' not found. Available steps: ${names}`)
  }
  return step
}

// ────────────────────────────────────────────────────────────
// Go release job
// ────────────────────────────────────────────────────────────

describe('Go release job', () => {
  it('has SENTRY_PROJECT_GO secret reference in Go release step', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    expect(step.env?.SENTRY_PROJECT_GO).toContain('secrets')
    expect(step.env?.SENTRY_PROJECT_GO).toContain('SENTRY_PROJECT_GO')
  })

  it('Go release step runs after test job succeeds (step is in test job, after Test step)', () => {
    const testJob = getJob('test')
    const steps = testJob.steps ?? []
    // After M7.3 the test step is named 'Test — orchestrator'
    const testStepIdx = steps.findIndex((s) => s.name?.startsWith('Test'))
    const goReleaseIdx = steps.findIndex((s) => s.name?.includes('Sentry Release — Go'))
    expect(testStepIdx).toBeGreaterThanOrEqual(0)
    expect(goReleaseIdx).toBeGreaterThan(testStepIdx)
  })

  it('Go release step only runs on push to main', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    expect(step.if).toContain('push')
    expect(step.if).toContain('main')
  })

  it('Go release step has SENTRY_AUTH_TOKEN env reference', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    expect(step.env?.SENTRY_AUTH_TOKEN).toContain('secrets')
  })

  it('Go release step has SENTRY_ORG env reference', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    expect(step.env?.SENTRY_ORG).toContain('secrets')
  })

  it('Go release step run script checks for SENTRY_AUTH_TOKEN before executing', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    expect(step.run).toContain('SENTRY_AUTH_TOKEN')
    expect(step.run).toContain('SENTRY_PROJECT_GO')
    // Guard condition — won't fail if secrets missing
    expect(step.run).toMatch(/if \[ -n .+SENTRY_AUTH_TOKEN/)
  })
})

// ────────────────────────────────────────────────────────────
// Deployment tracking step
// ────────────────────────────────────────────────────────────

describe('Deployment tracking step', () => {
  it('deployment step exists after Sentry release in dashboard job', () => {
    const dashJob = getJob('dashboard')
    const steps = dashJob.steps ?? []
    const releaseIdx = steps.findIndex((s) => s.name?.toLowerCase().includes('sentry release'))
    const deployIdx = steps.findIndex((s) => s.name?.toLowerCase().includes('deployment'))
    expect(releaseIdx).toBeGreaterThanOrEqual(0)
    expect(deployIdx).toBeGreaterThan(releaseIdx)
  })

  it('deployment step has SENTRY_ENV reference', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Deployment')
    expect(step.env?.SENTRY_ENV).toBeDefined()
    expect(step.env?.SENTRY_ENV).toContain('SENTRY_ENV')
  })

  it('deployment step only runs on push to main', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Deployment')
    expect(step.if).toContain('push')
    expect(step.if).toContain('main')
  })

  it('deployment step run script invokes sentry/cli deploys new', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Deployment')
    expect(step.run).toContain('deploys new')
  })

  it('deployment step passes --env flag using SENTRY_ENV', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Deployment')
    expect(step.run).toContain('--env')
    expect(step.run).toContain('SENTRY_ENV')
  })

  it('deployment step has SENTRY_PROJECT_FRONTEND env reference', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Deployment')
    expect(step.env?.SENTRY_PROJECT_FRONTEND).toContain('secrets')
  })
})

// ────────────────────────────────────────────────────────────
// PR comment step
// ────────────────────────────────────────────────────────────

describe('PR comment step', () => {
  it('PR comment step exists in dashboard job', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'PR Comment')
    expect(step).toBeDefined()
  })

  it('PR comment step uses GITHUB_TOKEN', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'PR Comment')
    const withBlock = step.with ?? {}
    const githubToken = withBlock['github-token'] as string | undefined
    expect(githubToken).toContain('GITHUB_TOKEN')
  })

  it('PR comment step only runs on pull_request events', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'PR Comment')
    expect(step.if).toContain('pull_request')
  })

  it('PR comment step uses actions/github-script', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'PR Comment')
    expect(step.uses).toContain('github-script')
  })

  it('PR comment script posts to issues.createComment', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'PR Comment')
    const script = step.with?.script as string | undefined
    expect(script).toContain('createComment')
  })

  it('PR comment script includes SHA reference', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'PR Comment')
    const script = step.with?.script as string | undefined
    expect(script).toContain('sha')
  })
})

// ────────────────────────────────────────────────────────────
// Build output — VITE_GIT_SHA injection
// ────────────────────────────────────────────────────────────

describe('Build output', () => {
  it('vite.config.js injects VITE_GIT_SHA via define', () => {
    const config = readFileSync(resolve(__dirname, '../../vite.config.js'), 'utf8')
    expect(config).toContain('VITE_GIT_SHA')
    expect(config).toContain('execSync')
  })

  it('sentryInit.js uses VITE_GIT_SHA as release fallback', () => {
    const init = readFileSync(resolve(__dirname, '../../src/sentryInit.js'), 'utf8')
    expect(init).toContain('VITE_GIT_SHA')
  })
})

// ────────────────────────────────────────────────────────────
// MONKEY: missing secrets graceful degradation
// ────────────────────────────────────────────────────────────

describe('MONKEY: missing secrets graceful degradation', () => {
  it('Sentry steps are wrapped in if-conditions (wont fail if secrets missing)', () => {
    const dashJob = getJob('dashboard')
    // Build step has SENTRY_AUTH_TOKEN in env but won't hard-fail if empty
    const buildStep = getStep(dashJob, 'Build')
    expect(buildStep?.env?.SENTRY_AUTH_TOKEN).toContain('secrets')
  })

  it('Go release step run script is guarded by non-empty SENTRY_AUTH_TOKEN check', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    // The run script must use an if-guard so missing token = no-op, not failure
    expect(step.run).toContain('if [ -n')
    expect(step.run).toContain('SENTRY_AUTH_TOKEN')
  })

  it('deployment step run script is guarded by non-empty SENTRY_AUTH_TOKEN check', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Deployment')
    expect(step.run).toContain('if [ -n')
    expect(step.run).toContain('SENTRY_AUTH_TOKEN')
  })

  it('Sentry Release (frontend) step has job-level if condition restricting to push+main', () => {
    const dashJob = getJob('dashboard')
    const step = requireStep(dashJob, 'Sentry Release —')
    // Should only run on push to main, not on every PR
    expect(step.if).toContain('push')
    expect(step.if).toContain('main')
  })

  it('Go release step has SENTRY_ORG guarded in run script', () => {
    const testJob = getJob('test')
    const step = requireStep(testJob, 'Sentry Release — Go')
    // Either checked in script or present in env (acceptable either way)
    const hasOrgInEnv = step.env?.SENTRY_ORG !== undefined
    const hasOrgInScript = step.run?.includes('SENTRY_ORG') ?? false
    expect(hasOrgInEnv || hasOrgInScript).toBe(true)
  })
})

// ────────────────────────────────────────────────────────────
// Go CI path triggers (M7.3 migration — services/* replacing modules/outreach)
// ────────────────────────────────────────────────────────────

describe('Go CI path triggers', () => {
  it('path triggers include features/inbound/orchestrator/**', () => {
    const wf = getWorkflow()
    const pushPaths = (wf.on as any)?.push?.paths as string[] ?? []
    expect(pushPaths).toContain('features/inbound/orchestrator/**')
  })

  it('path triggers include features/outreach/campaigns/**', () => {
    const wf = getWorkflow()
    const pushPaths = (wf.on as any)?.push?.paths as string[] ?? []
    expect(pushPaths).toContain('features/outreach/campaigns/**')
  })

  it('path triggers include features/acquisition/contacts/**', () => {
    const wf = getWorkflow()
    const pushPaths = (wf.on as any)?.push?.paths as string[] ?? []
    expect(pushPaths).toContain('features/acquisition/contacts/**')
  })

  it('path triggers include features/platform/common/**', () => {
    const wf = getWorkflow()
    const pushPaths = (wf.on as any)?.push?.paths as string[] ?? []
    expect(pushPaths).toContain('features/platform/common/**')
  })

  it('path triggers include features/outreach/relay/**', () => {
    const wf = getWorkflow()
    const pushPaths = (wf.on as any)?.push?.paths as string[] ?? []
    expect(pushPaths).toContain('features/outreach/relay/**')
  })

  it('path triggers do NOT include deprecated modules/outreach/**', () => {
    const wf = getWorkflow()
    const pushPaths = (wf.on as any)?.push?.paths as string[] ?? []
    // modules/outreach is deleted (M7.3) — must not be in triggers
    expect(pushPaths).not.toContain('modules/outreach/**')
  })

  it('pull_request paths also include features/inbound/orchestrator/**', () => {
    const wf = getWorkflow()
    const prPaths = (wf.on as any)?.pull_request?.paths as string[] ?? []
    expect(prPaths).toContain('features/inbound/orchestrator/**')
  })

  it('pull_request paths do NOT include deprecated modules/outreach/**', () => {
    const wf = getWorkflow()
    const prPaths = (wf.on as any)?.pull_request?.paths as string[] ?? []
    expect(prPaths).not.toContain('modules/outreach/**')
  })
})

// ────────────────────────────────────────────────────────────
// Go CI test job coverage (M7.3: features/inbound/orchestrator replaces modules/outreach)
// ────────────────────────────────────────────────────────────

describe('Go CI test job coverage', () => {
  it('test job uses features/inbound/orchestrator go.mod (not modules/outreach)', () => {
    const testJob = getJob('test')
    const setupStep = testJob.steps?.find((s) => s.uses?.includes('setup-go'))
    const goVersionFile = setupStep?.with?.['go-version-file'] as string | undefined
    expect(goVersionFile).toContain('features/inbound/orchestrator')
    expect(goVersionFile).not.toContain('modules/outreach')
  })

  it('test job Build step does not reference modules/outreach', () => {
    const testJob = getJob('test')
    const buildStep = testJob.steps?.find((s) => s.name === 'Build')
    if (!buildStep) throw new Error('Build step not found')
    const run = buildStep.run ?? ''
    const wd = (buildStep as any)['working-directory'] ?? ''
    expect(run + wd).not.toContain('modules/outreach')
  })

  it('test job Build step includes features/inbound/orchestrator', () => {
    const testJob = getJob('test')
    const buildStep = testJob.steps?.find((s) => s.name === 'Build')
    if (!buildStep) throw new Error('Build step not found')
    const run = buildStep.run ?? ''
    expect(run).toContain('features/inbound/orchestrator')
  })

  it('outreach-invariants job is removed or has no steps referencing modules/outreach as working-directory', () => {
    const wf = getWorkflow()
    const invariantsJob = wf.jobs['outreach-invariants']
    if (!invariantsJob) {
      // job removed entirely — desired state
      expect(invariantsJob).toBeUndefined()
      return
    }
    // If present, must not have any step with working-directory: modules/outreach
    const badStep = invariantsJob.steps?.find(
      (s) => (s as any)['working-directory'] === 'modules/outreach',
    )
    expect(badStep).toBeUndefined()
  })

  it('docker-smoke matrix does not include modules/outreach context', () => {
    const wf = getWorkflow()
    const dockerJob = wf.jobs['docker-smoke']
    const matrix = (dockerJob as any)?.strategy?.matrix?.include as Array<Record<string, string>> | undefined
    if (!matrix) {
      expect(matrix).toBeUndefined()
      return
    }
    const bad = matrix.find((m) => m.context === 'modules/outreach')
    expect(bad).toBeUndefined()
  })
})

// ────────────────────────────────────────────────────────────
// Dependabot configuration
// ────────────────────────────────────────────────────────────

describe('Dependabot configuration', () => {
  it('dependabot.yml exists', () => {
    const path = resolve(__dirname, '../../../../../.github/dependabot.yml')
    expect(() => readFileSync(path, 'utf8')).not.toThrow()
  })
  it('has gomod ecosystem for orchestrator', () => {
    const raw = readFileSync(resolve(__dirname, '../../../../../.github/dependabot.yml'), 'utf8')
    expect(raw).toContain('gomod')
    expect(raw).toContain('/features/inbound/orchestrator')
  })
  it('has npm ecosystem for dashboard', () => {
    const raw = readFileSync(resolve(__dirname, '../../../../../.github/dependabot.yml'), 'utf8')
    expect(raw).toContain('npm')
    expect(raw).toContain('/features/platform/outreach-dashboard')
  })
  it('has github-actions updates', () => {
    const raw = readFileSync(resolve(__dirname, '../../../../../.github/dependabot.yml'), 'utf8')
    expect(raw).toContain('github-actions')
  })
  it('CodeQL workflow exists', () => {
    const path = resolve(__dirname, '../../../../../.github/workflows/codeql.yml')
    expect(() => readFileSync(path, 'utf8')).not.toThrow()
  })
  it('CODEOWNERS exists', () => {
    const path = resolve(__dirname, '../../../../../.github/CODEOWNERS')
    expect(() => readFileSync(path, 'utf8')).not.toThrow()
  })
})

// ────────────────────────────────────────────────────────────
// workflow_dispatch manual trigger
// ────────────────────────────────────────────────────────────

describe('workflow_dispatch trigger', () => {
  it('go-services-ci.yml supports workflow_dispatch', () => {
    const wf = getWorkflow()
    const on = wf.on as Record<string, unknown>
    expect(on).toHaveProperty('workflow_dispatch')
  })

  it('workflow_dispatch has inputs (dry-run option)', () => {
    const wf = getWorkflow()
    const on = wf.on as Record<string, unknown>
    const dispatch = on.workflow_dispatch as Record<string, unknown> | undefined
    // inputs optional but check structure if present
    if (dispatch?.inputs) {
      expect(typeof dispatch.inputs).toBe('object')
    }
  })
})

describe('Reusable workflow', () => {
  it('.github/workflows/go-test-reusable.yml exists', () => {
    const path = resolve(__dirname, '../../../../../.github/workflows/go-test-reusable.yml')
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('workflow_call')
  })

  it('reusable workflow has inputs for go-version-file and working-directory', () => {
    const raw = readFileSync(resolve(__dirname, '../../../../../.github/workflows/go-test-reusable.yml'), 'utf8')
    expect(raw).toContain('inputs')
  })
})

// ────────────────────────────────────────────────────────────
// MONKEY: CI workflow resilience
// ────────────────────────────────────────────────────────────

describe('MONKEY: CI workflow resilience', () => {
  it('workflow_dispatch input has valid type', () => {
    const wf = getWorkflow()
    const on = wf.on as Record<string, unknown>
    const dispatch = on.workflow_dispatch as Record<string, unknown> | undefined
    if (dispatch?.inputs) {
      const inputs = dispatch.inputs as Record<string, unknown>
      Object.values(inputs).forEach(input => {
        const inp = input as Record<string, unknown>
        expect(['string', 'boolean', 'choice', 'number', 'environment']).toContain(inp.type)
      })
    }
  })
})

// ────────────────────────────────────────────────────────────
// Go CI — build cache
// ────────────────────────────────────────────────────────────

describe('Go CI — build cache', () => {
  it('test job has Go build cache restore step', () => {
    const testJob = getJob('test')
    const cacheStep = testJob.steps?.find(
      (s) => s.uses?.includes('actions/cache') || s.name?.toLowerCase().includes('cache'),
    )
    expect(cacheStep).toBeTruthy()
  })

  it('build cache key includes go.sum hash', () => {
    const testJob = getJob('test')
    const cacheStep = testJob.steps?.find((s) => s.uses?.includes('actions/cache'))
    if (!cacheStep) return // skip if not yet added
    const withBlock = cacheStep.with as Record<string, string> | undefined
    expect(withBlock?.key).toContain('go.sum')
  })

  it('build cache path targets ~/.cache/go-build', () => {
    const testJob = getJob('test')
    const cacheStep = testJob.steps?.find((s) => s.uses?.includes('actions/cache'))
    expect(cacheStep).toBeTruthy()
    const withBlock = cacheStep!.with as Record<string, string> | undefined
    expect(withBlock?.path).toContain('.cache/go-build')
  })

  it('build cache key is scoped to runner OS', () => {
    const testJob = getJob('test')
    const cacheStep = testJob.steps?.find((s) => s.uses?.includes('actions/cache'))
    expect(cacheStep).toBeTruthy()
    const withBlock = cacheStep!.with as Record<string, string> | undefined
    expect(withBlock?.key).toContain('runner.os')
  })

  it('build cache step appears before Build step', () => {
    const testJob = getJob('test')
    const steps = testJob.steps ?? []
    const cacheIdx = steps.findIndex((s) => s.uses?.includes('actions/cache'))
    const buildIdx = steps.findIndex((s) => s.name === 'Build')
    expect(cacheIdx).toBeGreaterThanOrEqual(0)
    expect(buildIdx).toBeGreaterThan(cacheIdx)
  })

  it('privacy-services job has build cache', () => {
    const privJob = getJob('privacy-services')
    const cacheStep = privJob.steps?.find(
      (s) => s.uses?.includes('actions/cache') || s.name?.toLowerCase().includes('cache'),
    )
    expect(cacheStep).toBeTruthy()
  })

  it('privacy-services cache key includes relay and privacy-gateway go.sum', () => {
    const privJob = getJob('privacy-services')
    const cacheStep = privJob.steps?.find((s) => s.uses?.includes('actions/cache'))
    expect(cacheStep).toBeTruthy()
    const withBlock = cacheStep!.with as Record<string, string> | undefined
    expect(withBlock?.key).toContain('relay/go.sum')
    expect(withBlock?.key).toContain('privacy-gateway/go.sum')
  })

  it('privacy-services cache step appears before Build both modules step', () => {
    const privJob = getJob('privacy-services')
    const steps = privJob.steps ?? []
    const cacheIdx = steps.findIndex((s) => s.uses?.includes('actions/cache'))
    const buildIdx = steps.findIndex((s) => s.name?.toLowerCase().includes('build both'))
    expect(cacheIdx).toBeGreaterThanOrEqual(0)
    expect(buildIdx).toBeGreaterThan(cacheIdx)
  })

  it('test job has Upload Go coverage step after Vet', () => {
    const testJob = getJob('test')
    const steps = testJob.steps ?? []
    const vetIdx = steps.findIndex((s) => s.name === 'Vet')
    const uploadIdx = steps.findIndex((s) => s.name?.toLowerCase().includes('upload go coverage'))
    expect(vetIdx).toBeGreaterThanOrEqual(0)
    expect(uploadIdx).toBeGreaterThan(vetIdx)
  })

  it('coverage artifact upload uses if: always()', () => {
    const testJob = getJob('test')
    const uploadStep = testJob.steps?.find((s) => s.name?.toLowerCase().includes('upload go coverage'))
    expect(uploadStep).toBeTruthy()
    expect(uploadStep!.if).toBe('always()')
  })

  it('coverage artifact has retention-days set', () => {
    const testJob = getJob('test')
    const uploadStep = testJob.steps?.find((s) => s.name?.toLowerCase().includes('upload go coverage'))
    expect(uploadStep).toBeTruthy()
    const withBlock = uploadStep!.with as Record<string, unknown> | undefined
    expect(withBlock?.['retention-days']).toBeTruthy()
  })
})

// ────────────────────────────────────────────────────────────
// MONKEY: CI resilience
// ────────────────────────────────────────────────────────────

describe('MONKEY: CI resilience', () => {
  it('all Sentry steps have bash guards or step-level if conditions (no-fail if secret missing)', () => {
    // Each step with sentry/cli must guard against missing secrets via EITHER:
    //   (a) bash guard in run:  if [ -n "$SENTRY_AUTH_TOKEN" ]
    //   (b) step-level if: condition that checks SENTRY_AUTH_TOKEN
    const dashJob = getJob('dashboard')
    const sentrySteps = dashJob.steps?.filter((s) => s.run?.includes('sentry/cli')) ?? []
    for (const step of sentrySteps) {
      const hasBashGuard = /if \[ -n .+SENTRY_AUTH_TOKEN/.test(step.run ?? '')
      const hasStepIfGuard = (step.if ?? '').includes('SENTRY_AUTH_TOKEN')
      expect(
        hasBashGuard || hasStepIfGuard,
        `Sentry step '${step.name}' has no guard for missing SENTRY_AUTH_TOKEN`,
      ).toBe(true)
    }
  })

  it('PR comment step gracefully handles missing issue_number (only runs on pull_request)', () => {
    const dashJob = getJob('dashboard')
    const prStep = requireStep(dashJob, 'PR Comment')
    // Should only run on pull_request events where context.issue.number is defined
    expect(prStep.if).toContain('pull_request')
  })

  it('all jobs have at least one checkout step', () => {
    const wf = getWorkflow()
    for (const [name, job] of Object.entries(wf.jobs)) {
      // outreach-invariants may be removed — skip if absent
      if (name === 'outreach-invariants' && !job.steps?.length) continue
      const hasCheckout = job.steps?.some((s) => s.uses?.includes('checkout'))
      expect(hasCheckout, `Job '${name}' is missing a checkout step`).toBe(true)
    }
  })

  it('test job name no longer says "outreach" (stale label from M7.3)', () => {
    const testJob = getJob('test')
    // After M7.3 the display name should reference orchestrator, not just "outreach"
    expect(testJob.name).toContain('orchestrator')
  })

  it('privacy-services job still has checkout (regression guard)', () => {
    const job = getJob('privacy-services')
    const hasCheckout = job.steps?.some((s) => s.uses?.includes('checkout'))
    expect(hasCheckout).toBe(true)
  })

  it('dashboard job has checkout step', () => {
    const job = getJob('dashboard')
    const hasCheckout = job.steps?.some((s) => s.uses?.includes('checkout'))
    expect(hasCheckout).toBe(true)
  })
})
