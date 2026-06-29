// Unit tests: worker shutdown + process handlers + constants
// No Redis, no BullMQ, no Firebase. Pure function tests.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  runShutdown,
  installProcessHandlers,
  REMOVE_ON_COMPLETE,
  REMOVE_ON_FAIL,
  SHUTDOWN_TIMEOUT_MS,
  MAX_ITER_BUDGET_MS,
  maybeShortCircuit,
} from './index.js'

// ── Constants ─────────────────────────────────────────────────────────────

describe('worker constants', () => {
  it('REMOVE_ON_COMPLETE.count is 100 (Redis memory budget)', () => {
    expect(REMOVE_ON_COMPLETE).toEqual({ count: 100 })
  })

  it('REMOVE_ON_FAIL.count is 200', () => {
    expect(REMOVE_ON_FAIL).toEqual({ count: 200 })
  })

  it('SHUTDOWN_TIMEOUT_MS defaults to 30 000 ms', () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(30_000)
  })

  it('MAX_ITER_BUDGET_MS defaults to 300 000 ms (5 min)', () => {
    expect(MAX_ITER_BUDGET_MS).toBe(300_000)
  })
})

// ── runShutdown ───────────────────────────────────────────────────────────

vi.mock('./firebase.js', () => ({
  fileExists: vi.fn().mockResolvedValue(false),
  getSignedUrl: vi.fn().mockResolvedValue('https://cdn.example.com/file'),
  downloadFiles: vi.fn().mockResolvedValue([]),
  uploadResults: vi.fn().mockResolvedValue({ outputPath: 'x.pdf', downloadUrl: 'https://x', docxUrl: 'https://x.docx' }),
  uploadFile: vi.fn().mockResolvedValue('https://url'),
}))
vi.mock('./generate-odpor.js', () => ({
  generateOdpor: vi.fn(),
  closeMcp: vi.fn(),
}))
vi.mock('./email.js', () => ({ sendResultEmail: vi.fn() }))
vi.mock('./pdf.js', () => ({ docxToPdf: vi.fn() }))
vi.mock('../scripts/lib/docx-writer.js', () => ({ markdownToDocx: vi.fn() }))

function makeLog() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() }
}

describe('runShutdown', () => {
  it('returns 0 on clean shutdown', async () => {
    const deps = {
      worker: { close: vi.fn().mockResolvedValue(undefined) },
      connection: { quit: vi.fn().mockResolvedValue('OK') },
      closeMcpClient: vi.fn(),
      log: makeLog(),
      timeoutMs: 5000,
    }
    const code = await runShutdown(deps)
    expect(code).toBe(0)
    expect(deps.worker.close).toHaveBeenCalledOnce()
    expect(deps.connection.quit).toHaveBeenCalledOnce()
    expect(deps.closeMcpClient).toHaveBeenCalledOnce()
  })

  it('returns 1 when timeout exceeded', async () => {
    const deps = {
      worker: { close: vi.fn().mockImplementation(() => new Promise(() => {})) }, // never resolves
      connection: { quit: vi.fn() },
      closeMcpClient: vi.fn(),
      log: makeLog(),
      timeoutMs: 10, // 10ms timeout
    }
    const code = await runShutdown(deps)
    expect(code).toBe(1)
  })

  it('returns 1 when worker.close() throws', async () => {
    const deps = {
      worker: { close: vi.fn().mockRejectedValue(new Error('BullMQ error')) },
      connection: { quit: vi.fn().mockResolvedValue('OK') },
      closeMcpClient: vi.fn(),
      log: makeLog(),
      timeoutMs: 5000,
    }
    const code = await runShutdown(deps)
    expect(code).toBe(1)
  })

  it('tolerates Redis quit() rejection (already closed)', async () => {
    const deps = {
      worker: { close: vi.fn().mockResolvedValue(undefined) },
      connection: { quit: vi.fn().mockRejectedValue(new Error('already closed')) },
      closeMcpClient: vi.fn(),
      log: makeLog(),
      timeoutMs: 5000,
    }
    const code = await runShutdown(deps)
    expect(code).toBe(0) // Redis quit() failure is tolerated
    expect(deps.log.warn).toHaveBeenCalled()
  })
})

// ── installProcessHandlers ─────────────────────────────────────────────────

describe('installProcessHandlers', () => {
  it('registers SIGTERM, SIGINT, uncaughtException, unhandledRejection', () => {
    const mockProcess = {
      on: vi.fn(),
    } as unknown as NodeJS.Process

    installProcessHandlers({
      onShutdown: vi.fn().mockResolvedValue(undefined),
      onFatal: vi.fn(),
      processRef: mockProcess,
    })

    const registeredEvents = (mockProcess.on as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(registeredEvents).toContain('SIGTERM')
    expect(registeredEvents).toContain('SIGINT')
    expect(registeredEvents).toContain('uncaughtException')
    expect(registeredEvents).toContain('unhandledRejection')
  })

  it('SIGTERM triggers onShutdown', () => {
    const onShutdown = vi.fn().mockResolvedValue(undefined)
    const mockProcess = { on: vi.fn() } as unknown as NodeJS.Process

    installProcessHandlers({ onShutdown, onFatal: vi.fn(), processRef: mockProcess })

    const sigtermHandler = (mockProcess.on as ReturnType<typeof vi.fn>).mock.calls
      .find(c => c[0] === 'SIGTERM')?.[1]
    sigtermHandler?.()
    expect(onShutdown).toHaveBeenCalledWith('SIGTERM')
  })
})

// ── maybeShortCircuit ──────────────────────────────────────────────────────

describe('maybeShortCircuit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns null when PDF does not exist (no short-circuit)', async () => {
    const { fileExists } = await import('./firebase.js')
    ;(fileExists as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    const result = await maybeShortCircuit('session-123')
    expect(result).toBeNull()
  })

  it('returns URLs when PDF exists (idempotent replay)', async () => {
    const { fileExists, getSignedUrl } = await import('./firebase.js')
    ;(fileExists as ReturnType<typeof vi.fn>).mockResolvedValue(true)
    ;(getSignedUrl as ReturnType<typeof vi.fn>).mockResolvedValue('https://cdn.test/file')
    const result = await maybeShortCircuit('session-abc')
    expect(result).not.toBeNull()
    expect(result?.downloadUrl).toBeTruthy()
    expect(result?.outputPath).toContain('session-abc')
  })
})
