import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCatalogueClient,
  CatalogueUnavailableError,
  ProductNotFoundError,
} from '../../src/clients/catalogueClient.js';

const productId = '11111111-1111-4111-8111-111111111111';

describe('catalogueClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the product when catalogue responds with 200', async () => {
    const product = { id: productId, name: 'Test', priceCents: 1000 };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(product), { status: 200 })),
    );

    const client = createCatalogueClient({ baseUrl: 'http://catalogue.local', timeoutMs: 1000 });
    await expect(client.getProduct(productId)).resolves.toMatchObject(product);
  });

  it('throws ProductNotFoundError when catalogue responds with 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const client = createCatalogueClient({ baseUrl: 'http://catalogue.local', timeoutMs: 1000 });
    await expect(client.getProduct(productId)).rejects.toBeInstanceOf(ProductNotFoundError);
  });

  it('throws CatalogueUnavailableError on a 500 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 500 })),
    );

    const client = createCatalogueClient({ baseUrl: 'http://catalogue.local', timeoutMs: 1000 });
    await expect(client.getProduct(productId)).rejects.toBeInstanceOf(CatalogueUnavailableError);
  });

  it('throws CatalogueUnavailableError when the request times out', async () => {
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

    const client = createCatalogueClient({ baseUrl: 'http://catalogue.local', timeoutMs: 10 });
    await expect(client.getProduct(productId)).rejects.toBeInstanceOf(CatalogueUnavailableError);
  });

  it('throws CatalogueUnavailableError when the network call fails outright', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const client = createCatalogueClient({ baseUrl: 'http://catalogue.local', timeoutMs: 1000 });
    await expect(client.getProduct(productId)).rejects.toBeInstanceOf(CatalogueUnavailableError);
  });

  it('forwards the requestId as x-request-id for cross-service log correlation', async () => {
    const product = { id: productId, name: 'Test', priceCents: 1000 };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(product), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createCatalogueClient({ baseUrl: 'http://catalogue.local', timeoutMs: 1000 });
    await client.getProduct(productId, 'req-abc-123');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-request-id']).toBe('req-abc-123');
  });
});
