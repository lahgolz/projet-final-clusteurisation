import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createLogger } from '@microservice-app/shared';
import { buildApp } from '../../src/app.js';

const UNREACHABLE_DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/invalid';

describe('metrics route', () => {
  it('GET /metrics exposes request counters with bounded-cardinality labels', async () => {
    const pool = new Pool({
      connectionString: UNREACHABLE_DATABASE_URL,
      connectionTimeoutMillis: 200,
    });
    const app = buildApp({ pool, logger: createLogger('catalogue-test', 'silent') });

    await app.inject({ method: 'GET', url: '/health/live' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('http_requests_total{method="GET"');
    expect(response.body).toContain('route="/health/live"');
    expect(response.body).toContain('status_code="200"');
    expect(response.body).toContain('service="catalogue"');
    expect(response.body).toContain('http_request_duration_seconds_bucket');
    expect(response.body).toContain('db_pool_connections');

    await app.close();
    await pool.end();
  });
});
