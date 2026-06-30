// Typový sidecar k vitest.setup.mjs (runtime kód je .mjs kvůli Vite8/oxc tsconfig lookupu;
// tsc bere typy odsud, když ho src/*.test.ts importuje extensionless přes '../../vitest.setup').
import type { SetupServerApi } from 'msw/node';
export declare const server: SetupServerApi;
