import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchWithTimeout, TimeoutError } from './http.js';

describe('fetchWithTimeout', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('resolves when the request completes before the timeout', async () => {
    const response = new Response('ok');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );

    const result = await fetchWithTimeout('http://example.test', { timeoutMs: 1000 });

    expect(result).toBe(response);
  });

  it('throws a TimeoutError when the request exceeds the timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }),
    );

    await expect(fetchWithTimeout('http://example.test', { timeoutMs: 10 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('propagates non-timeout errors as-is', async () => {
    const boom = new Error('network down');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw boom;
      }),
    );

    await expect(fetchWithTimeout('http://example.test', { timeoutMs: 1000 })).rejects.toBe(boom);
  });
});
