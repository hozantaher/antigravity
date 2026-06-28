import { create } from 'zustand'

interface HealthState {
  degraded: boolean
  lastChecked: number | null
  setDegraded: (v: boolean) => void
}

export const useOutreachHealth = create<HealthState>((set) => ({
  degraded: false,
  lastChecked: null,
  setDegraded: (degraded) => set({ degraded, lastChecked: Date.now() }),
}))

// Expose setDegraded on window for Playwright E2E tests (dev + test only).
// This allows specs to flip the degraded state without mocking BFF timing.
if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__outreachHealthSetDegraded =
    (v: boolean) => useOutreachHealth.getState().setDegraded(v)
}
