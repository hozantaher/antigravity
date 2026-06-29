import { beforeAll, afterAll, afterEach } from 'vitest';
import { setupServer } from 'msw/node';

// Vytvoříme MSW server bez jakýchkoliv defaultních handlerů.
// Tím pádem VŠECHNY odchozí síťové požadavky budou zachyceny.
export const server = setupServer();

beforeAll(() => {
  // onUnhandledRequest: 'error' zaručí, že test SPADNE, pokud zavolá síť ven
  // bez explicitního VCR mocku. To je náš štít pro HANDS a BRAIN vrstvy.
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
});

afterAll(() => {
  server.close();
});
