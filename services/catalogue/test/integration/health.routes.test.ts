import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createLogger } from '@microservice-app/shared';
import { buildApp } from '../../src/app.js';

const UNREACHABLE_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid';

describe('health routes', () => {
  it('GET /health/live returns 200 without depending on PostgreSQL', async () => {
    const pool = new Pool({
      connectionString: UNREACHABLE_DATABASE_URL,
      connectionTimeoutMillis: 200,
    });
    const app = buildApp({ pool, logger: createLogger('catalogue-test', 'silent') });

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', service: 'catalogue' });

    await app.close();
    await pool.end();
  });

  it('GET /health/ready returns 503 when PostgreSQL is unreachable', async () => {
    const pool = new Pool({
      connectionString: UNREACHABLE_DATABASE_URL,
      connectionTimeoutMillis: 200,
    });
    const app = buildApp({ pool, logger: createLogger('catalogue-test', 'silent') });

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', service: 'catalogue' });

    await app.close();
    await pool.end();
  });
});
