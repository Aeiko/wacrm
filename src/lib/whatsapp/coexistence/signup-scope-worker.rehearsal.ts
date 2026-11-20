import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { SupervisedSignupInvitation } from './supervised-signup';

export type SignupScope = 'first' | 'second';

type Handle = (
  request: Request,
  invite: SupervisedSignupInvitation
) => Promise<Response>;

export type ScopeRequest =
  | { id: number; cancel: true }
  | {
      id: number;
      url: string;
      method: string;
      headers: [string, string][];
      body: ArrayBuffer | null;
      invite: SupervisedSignupInvitation;
    };

export type ScopeReply = {
  id: number;
  response?: {
    status: number;
    headers: [string, string][];
    body: string | null;
  };
};

async function workerSource() {
  // Use Vite's installed bundler directly: no Vite config, dotenv, or disk output.
  const { rolldown } = await import('rolldown');

  const bundle = await rolldown({
    input: fileURLToPath(
      new URL('./signup-scope-worker-entry.rehearsal.ts', import.meta.url)
    ),
    platform: 'node',
  });

  try {
    const { output } = await bundle.generate({
      format: 'cjs',
      codeSplitting: false,
    });

    const entry = output.find(
      (chunk) => chunk.type === 'chunk' && chunk.isEntry
    );

    if (entry?.type !== 'chunk')
      throw new Error('Missing signup scope worker entry');

    return entry.code;
  } finally {
    await bundle.close();
  }
}

/** Test-only composition. The private host does not forward fixture headers. */
export async function withSignupScopeWorker(
  scope: SignupScope,
  run: (handle: Handle) => Promise<void>
): Promise<void> {
  const origin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin) ||
    URL.parse(origin)?.origin !== origin ||
    !anon ||
    !service
  )
    throw new Error('Expected a disposable signup bridge');

  const worker = new Worker(await workerSource(), {
    eval: true,
    execArgv: [],
    stdout: true,
    stderr: true,
    workerData: scope,
    env: {
      NODE_ENV: 'test',
      // Encryption captures this at module load, before the worker entry executes.
      ENCRYPTION_KEY: 'a'.repeat(64),
      NEXT_PUBLIC_SUPABASE_URL: origin,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: anon,
      SUPABASE_SERVICE_ROLE_KEY: service,
    },
  });

  worker.stdout.resume();
  worker.stderr.resume();

  let nextId = 0;
  let closed = false;

  const pending = new Map<
    number,
    (response?: ScopeReply['response']) => void
  >();

  const close = () => {
    closed = true;

    for (const settle of pending.values()) settle();
    pending.clear();
  };

  worker.on('error', close);
  worker.on('exit', close);
  worker.on('message', ({ id, response }: ScopeReply) => {
    const settle = pending.get(id);
    pending.delete(id);
    settle?.(response);
  });

  const handle: Handle = async (request, invite) => {
    const body = request.body === null ? null : await request.arrayBuffer();
    const { signal } = request;

    if (closed) throw new Error('Signup scope worker unavailable');

    if (signal.aborted)
      throw new DOMException('Signup request cancelled', 'AbortError');

    const id = ++nextId;

    return new Promise<Response>((resolve, reject) => {
      const cancel = () => {
        worker.postMessage({ id, cancel: true } satisfies ScopeRequest);
        pending.delete(id);
        reject(new DOMException('Signup request cancelled', 'AbortError'));
      };

      signal.addEventListener('abort', cancel, { once: true });
      pending.set(id, (response) => {
        signal.removeEventListener('abort', cancel);

        if (!response) return reject(new Error('Signup scope worker failed'));

        const { body, status, headers } = response;
        resolve(new Response(body, { status, headers }));
      });

      try {
        worker.postMessage({
          id,
          url: request.url,
          method: request.method,
          headers: [...request.headers],
          body,
          invite,
        } satisfies ScopeRequest);
      } catch {
        pending.get(id)?.();
        pending.delete(id);
      }
    });
  };

  try {
    await run(handle);

    if (closed) throw new Error('Signup scope worker failed');
  } finally {
    close();
    await worker.terminate();
  }
}
