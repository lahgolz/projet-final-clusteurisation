import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TIMEOUT_MS, listProducts } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('api client', () => {
  it('resolves with the parsed JSON body on a 2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ products: [] }), { status: 200 })),
    );

    await expect(listProducts()).resolves.toEqual({ products: [] });
  });

  it('throws an ApiError carrying the server message on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'boom' } }), {
            status: 500,
          }),
      ),
    );

    await expect(listProducts()).rejects.toMatchObject({ message: 'boom', status: 500 });
  });

  it('throws a network-flavored ApiError when fetch rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await expect(listProducts()).rejects.toMatchObject({
      message: expect.stringMatching(/impossible de contacter/i),
    });
  });

  it('throws a timeout-flavored ApiError when the request exceeds the timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );

    const promise = listProducts();
    const assertion = expect(promise).rejects.toMatchObject({
      message: expect.stringMatching(/expiré/i),
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);
    await assertion;
  });
});
