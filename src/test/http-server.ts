import { once } from 'node:events';
import type { Server } from 'node:http';
import { z } from 'zod';

// Fetch blocks these unprivileged ports even when the OS allocates them for listen(0).
const blockedFetchPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666,
  6667, 6668, 6669, 6679, 6697, 10080,
]);

export function isFetchPort(port: number): boolean {
  return port >= 1024 && !blockedFetchPorts.has(port);
}

/** Allocate a loopback fixture origin before making any HTTP requests. */
export async function listenForFetch(server: Server): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const { port } = z.object({ port: z.number() }).parse(server.address());

    if (isFetchPort(port)) return `http://127.0.0.1:${port}`;

    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  throw new Error(
    'Could not allocate a fetch-compatible loopback port after 20 attempts'
  );
}
