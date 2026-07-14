import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createLogger, type Product } from '@microservice-app/shared';
import { buildApp } from '../../src/app.js';
import {
  ProductNotFoundError,
  CatalogueUnavailableError,
} from '../../src/clients/catalogueClient.js';
import type { CatalogueClient } from '../../src/clients/catalogueClient.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

function fakeCatalogueClient(impl: (productId: string) => Promise<Product>): CatalogueClient {
  return { getProduct: impl };
}

function makeProduct(id: string, priceCents: number): Product {
  return {
    id,
    name: 'Fixture product',
    description: null,
    priceCents,
    currency: 'EUR',
    stock: 100,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describeIfDb('orders routes (integration)', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const fixtureProductId = randomUUID();
  const fixturePriceCents = 2500;

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO products (id, name, description, price_cents, currency, stock)
       VALUES ($1, 'Fixture product', 'Created by vitest', $2, 'EUR', 100)`,
      [fixtureProductId, fixturePriceCents],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM order_items WHERE product_id = $1', [fixtureProductId]);
    await pool.query('DELETE FROM products WHERE id = $1', [fixtureProductId]);
    await pool.end();
  });

  async function countOrders(): Promise<number> {
    const result = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM orders',
    );
    return Number(result.rows[0]?.count ?? '0');
  }

  it('creates a valid order and computes the total server-side', async () => {
    const catalogueClient = fakeCatalogueClient(async (id) => makeProduct(id, fixturePriceCents));
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { items: [{ productId: fixtureProductId, quantity: 3 }] },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.totalCents).toBe(fixturePriceCents * 3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      productId: fixtureProductId,
      quantity: 3,
      unitPriceCents: fixturePriceCents,
    });

    const getResponse = await app.inject({ method: 'GET', url: `/api/orders/${body.id}` });
    expect(getResponse.statusCode).toBe(200);
    expect(getResponse.json()).toMatchObject({ id: body.id, totalCents: fixturePriceCents * 3 });

    await app.close();
  });

  it('rejects an invalid payload without creating an order', async () => {
    const catalogueClient = fakeCatalogueClient(async (id) => makeProduct(id, fixturePriceCents));
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });
    const before = await countOrders();

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { items: [] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
    expect(await countOrders()).toBe(before);

    await app.close();
  });

  it('returns 404 when a referenced product does not exist, without creating an order', async () => {
    const missingProductId = randomUUID();
    const catalogueClient = fakeCatalogueClient(async () => {
      throw new ProductNotFoundError(missingProductId);
    });
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });
    const before = await countOrders();

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { items: [{ productId: missingProductId, quantity: 1 }] },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } });
    expect(await countOrders()).toBe(before);

    await app.close();
  });

  it('returns 502 when catalogue is unavailable, without creating an order', async () => {
    const catalogueClient = fakeCatalogueClient(async () => {
      throw new CatalogueUnavailableError('simulated outage');
    });
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });
    const before = await countOrders();

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { items: [{ productId: fixtureProductId, quantity: 1 }] },
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'CATALOGUE_UNAVAILABLE' } });
    expect(await countOrders()).toBe(before);

    await app.close();
  });

  it('rolls back the whole order when persisting an item fails', async () => {
    const phantomProductId = randomUUID();
    const catalogueClient = fakeCatalogueClient(async (id) => makeProduct(id, 999));
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });
    const before = await countOrders();

    const response = await app.inject({
      method: 'POST',
      url: '/api/orders',
      payload: { items: [{ productId: phantomProductId, quantity: 1 }] },
    });

    expect(response.statusCode).toBe(500);
    expect(await countOrders()).toBe(before);

    await app.close();
  });

  it('returns 404 when reading a non-existent order', async () => {
    const catalogueClient = fakeCatalogueClient(async (id) => makeProduct(id, fixturePriceCents));
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });

    const response = await app.inject({ method: 'GET', url: `/api/orders/${randomUUID()}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'ORDER_NOT_FOUND' } });

    await app.close();
  });

  it('returns 400 when reading an order with a malformed id', async () => {
    const catalogueClient = fakeCatalogueClient(async (id) => makeProduct(id, fixturePriceCents));
    const app = buildApp({ pool, logger: createLogger('orders-test', 'silent'), catalogueClient });

    const response = await app.inject({ method: 'GET', url: '/api/orders/not-a-uuid' });

    expect(response.statusCode).toBe(400);

    await app.close();
  });
});
