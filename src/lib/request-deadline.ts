import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestDeadline {
  deadline: number;
  signal?: AbortSignal;
}

const requestDeadline = new AsyncLocalStorage<RequestDeadline>();

/** Run one action under an absolute Unix-millisecond HTTP deadline. */
export function withRequestDeadline<T>(
  deadline: number,
  action: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const parent = requestDeadline.getStore();
  const inheritedSignal = parent?.signal;

  return requestDeadline.run(
    {
      deadline: parent ? Math.min(deadline, parent.deadline) : deadline,
      signal:
        inheritedSignal && signal
          ? AbortSignal.any([inheritedSignal, signal])
          : (signal ?? inheritedSignal),
    },
    action
  );
}

export async function deadlineFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const scope = requestDeadline.getStore();

  if (scope === undefined) return globalThis.fetch(input, init);

  const remaining = scope.deadline - Date.now();

  if (remaining <= 0)
    throw new DOMException('Request deadline elapsed', 'AbortError');

  const callerSignal =
    init?.signal !== undefined
      ? init.signal
      : input instanceof Request
        ? input.signal
        : undefined;

  const timeoutSignal = AbortSignal.timeout(remaining);

  const signals = [timeoutSignal];

  if (scope.signal) signals.push(scope.signal);

  if (callerSignal) signals.push(callerSignal);

  const signal = AbortSignal.any(signals);

  try {
    return await globalThis.fetch(input, { ...init, signal });
  } catch (error) {
    // PostgREST retries TimeoutError unless its own input signal was aborted.
    if (timeoutSignal.aborted && signal.reason === timeoutSignal.reason)
      throw new DOMException('Request deadline elapsed', 'AbortError');

    if (scope.signal?.aborted && signal.reason === scope.signal.reason)
      throw new DOMException('Request cancelled', 'AbortError');

    throw error;
  }
}
