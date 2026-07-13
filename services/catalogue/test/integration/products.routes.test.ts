import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createLogger } from '@microshop/shared';
import { buildApp } from '../../src/app.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb('products routes (integration)', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl });
  const app = buildApp({ pool, logger: createLogger('catalogue-test', 'silent') });
  const productId = randomUUID();

  beforeAll(async () => {
    await pool.query(
      `INSERT INTO products (id, name, description, price_cents, currency, stock)
       VALUES ($1, $2, $3, $4, 'EUR', $5)`,
      [productId, 'Integration test product', 'Fixture created by vitest', 1234, 7],
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM products WHERE id = $1', [productId]);
    await app.close();
    await pool.end();
  });

  it('lists products including the fixture', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/products' });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { products: Array<{ id: string }> };
    expect(body.products.some((p) => p.id === productId)).toBe(true);
  });

  it('returns a single product by id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/catalogue/products/${productId}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: productId,
      name: 'Integration test product',
      priceCents: 1234,
      stock: 7,
    });
  });

  it('returns 404 for an unknown product id', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/catalogue/products/${randomUUID()}`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'PRODUCT_NOT_FOUND' } });
  });

  it('returns 400 for a malformed product id', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/products/not-a-uuid' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } });
  });

  it('returns 400 for an out-of-range limit query parameter', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/catalogue/products?limit=9999' });

    expect(response.statusCode).toBe(400);
  });
});
