import client from 'prom-client';

export interface ServiceMetrics {
  registry: client.Registry;
  httpRequestsTotal: client.Counter<'method' | 'route' | 'status_code'>;
  httpRequestDurationSeconds: client.Histogram<'method' | 'route' | 'status_code'>;
  dbPoolConnections: client.Gauge<'state'>;
}

export interface HttpRequestObservation {
  method: string;
  route: string;
  statusCode: number;
  durationMs: number;
}

export interface DbPoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export function createMetrics(service: string): ServiceMetrics {
  const registry = new client.Registry();
  registry.setDefaultLabels({ service });
  client.collectDefaultMetrics({ register: registry });

  const httpRequestsTotal = new client.Counter({
    name: 'http_requests_total',
    help: 'Total number of HTTP requests received',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  const httpRequestDurationSeconds = new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registry],
  });

  const dbPoolConnections = new client.Gauge({
    name: 'db_pool_connections',
    help: 'PostgreSQL connection pool state (total, idle, waiting)',
    labelNames: ['state'] as const,
    registers: [registry],
  });

  return { registry, httpRequestsTotal, httpRequestDurationSeconds, dbPoolConnections };
}

export function observeHttpRequest(metrics: ServiceMetrics, fields: HttpRequestObservation): void {
  const labels = {
    method: fields.method,
    route: fields.route,
    status_code: String(fields.statusCode),
  };
  metrics.httpRequestsTotal.inc(labels);
  metrics.httpRequestDurationSeconds.observe(labels, fields.durationMs / 1000);
}

export function observeDbPool(metrics: ServiceMetrics, stats: DbPoolStats): void {
  metrics.dbPoolConnections.set({ state: 'total' }, stats.totalCount);
  metrics.dbPoolConnections.set({ state: 'idle' }, stats.idleCount);
  metrics.dbPoolConnections.set({ state: 'waiting' }, stats.waitingCount);
}
