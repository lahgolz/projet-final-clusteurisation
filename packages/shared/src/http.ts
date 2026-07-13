export class TimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`Request to ${url} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs: number;
}

export async function fetchWithTimeout(
  url: string,
  { timeoutMs, signal, ...init }: FetchWithTimeoutOptions,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new TimeoutError(url, timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
