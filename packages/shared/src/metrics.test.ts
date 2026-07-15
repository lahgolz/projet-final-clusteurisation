import { describe, expect, it } from 'vitest';
import { createMetrics, observeDbPool, observeHttpRequest } from './metrics.js';

describe('metrics', () => {
  it('exposes HTTP request counters and histograms scoped to the service', async () => {
    const metrics = createMetrics('catalogue');

    observeHttpRequest(metrics, {
      method: 'GET',
      route: '/api/catalogue/products/:id',
      statusCode: 200,
      durationMs: 42,
    });

    const output = await metrics.registry.metrics();

    expect(output).toContain('http_requests_total{method="GET"');
    expect(output).toContain('route="/api/catalogue/products/:id"');
    expect(output).toContain('status_code="200"');
    expect(output).toContain('service="catalogue"');
    expect(output).toContain('http_request_duration_seconds_bucket');
  });

  it('does not leak unbounded-cardinality identifiers as labels', async () => {
    const metrics = createMetrics('orders');

    observeHttpRequest(metrics, {
      method: 'GET',
      route: '/api/orders/:id',
      statusCode: 200,
      durationMs: 5,
    });

    const output = await metrics.registry.metrics();

    expect(output).not.toContain('/api/orders/550e8400-e29b-41d4-a716-446655440000');
  });

  it('reports connection pool gauges', async () => {
    const metrics = createMetrics('catalogue-pool');

    observeDbPool(metrics, { totalCount: 10, idleCount: 7, waitingCount: 1 });

    const output = await metrics.registry.metrics();

    expect(output).toContain('db_pool_connections{state="total",service="catalogue-pool"} 10');
    expect(output).toContain('db_pool_connections{state="idle",service="catalogue-pool"} 7');
    expect(output).toContain('db_pool_connections{state="waiting",service="catalogue-pool"} 1');
  });
});
