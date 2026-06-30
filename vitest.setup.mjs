import { beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';

// MSW server bez jakýchkoliv defaultních handlerů → VŠECHNY odchozí síťové požadavky zachyceny.
export const server = setupServer();

beforeAll(() => {
  // onUnhandledRequest: 'error' zaručí, že test SPADNE, pokud zavolá síť ven bez explicitního
  // mocku. To je náš štít pro HANDS a BRAIN vrstvy (a pro RunPod LLM calls v testech).
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
