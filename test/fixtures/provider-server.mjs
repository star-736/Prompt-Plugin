import { createServer } from 'node:http';
import { once } from 'node:events';

// A synthetic HTTPS origin is routed only to this loopback server. Production
// HTTPS validation stays unchanged; neither real credentials nor services are used.
export const FIXTURE_PROVIDER_URL = 'https://provider.fixture.invalid/v1';
export const FIXTURE_KEY = 'fixture-only-not-a-provider-credential';

export function completion(value) {
  return { choices: [{ message: { content: JSON.stringify(value) } }] };
}

export async function createProviderServer(handler = () => {}) {
  const requests = [];
  const waiters = [];
  const server = createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    let text = '';
    for await (const chunk of request) text += chunk;
    const closed = new Promise((resolve) => response.once('close', resolve));
    const entry = {
      method: request.method, path: request.url,
      authorized: request.headers.authorization === `Bearer ${FIXTURE_KEY}`,
      contentType: request.headers['content-type'], body: JSON.parse(text), response, closed,
      respond(status, value) {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(value));
      }
    };
    requests.push(entry);
    waiters.shift()?.resolve(entry);
    handler(entry, requests.length);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const nativeFetch = globalThis.fetch;
  let consumed = 0;
  return {
    origin, requests,
    fetch(url, options) {
      if (url !== `${FIXTURE_PROVIDER_URL}/chat/completions`) throw new Error('Fixture blocked a non-test endpoint.');
      return nativeFetch(`${origin}/v1/chat/completions`, options);
    },
    async nextRequest() {
      if (requests[consumed]) return requests[consumed++];
      return new Promise((resolve, reject) => {
        const waiter = {
          resolve(entry) { clearTimeout(timer); consumed += 1; resolve(entry); },
          reject(error) { clearTimeout(timer); reject(error); }
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('Timed out waiting for a loopback Provider request.'));
        }, 5000);
        waiters.push(waiter);
      });
    },
    async close() {
      for (const waiter of waiters.splice(0)) waiter.reject(new Error('Loopback Provider fixture closed.'));
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    }
  };
}
