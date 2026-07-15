import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createMetrics,
  logHttpRequest,
  observeDbPool,
  observeHttpRequest,
  type Logger,
} from '@microservice-app/shared';
import { productsRoutes } from './routes/products.routes.js';
import { healthRoutes } from './routes/health.routes.js';

const SERVICE_NAME = 'catalogue';
const DB_POOL_METRICS_INTERVAL_MS = 5_000;

declare module 'fastify' {
  interface FastifyRequest {
    startTimeNs: bigint;
  }
}

export interface BuildAppOptions {
  pool: Pool;
  logger: Logger;
}

export function buildApp({ pool, logger }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: (request) => (request.headers['x-request-id'] as string | undefined) ?? randomUUID(),
    forceCloseConnections: 'idle',
  });

  const metrics = createMetrics(SERVICE_NAME);

  app.decorateRequest('startTimeNs');

  app.addHook('onRequest', async (request: FastifyRequest, reply) => {
    request.startTimeNs = process.hrtime.bigint();
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Number((process.hrtime.bigint() - request.startTimeNs) / 1_000_000n);
    const route = request.routeOptions.url ?? request.url;
    logHttpRequest(logger, {
      method: request.method,
      path: route,
      statusCode: reply.statusCode,
      durationMs,
      requestId: String(request.id),
    });
    observeHttpRequest(metrics, {
      method: request.method,
      route,
      statusCode: reply.statusCode,
      durationMs,
    });
  });

  const recordDbPoolMetrics = (): void => {
    observeDbPool(metrics, {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    });
  };
  recordDbPoolMetrics();
  const dbPoolMetricsTimer = setInterval(recordDbPoolMetrics, DB_POOL_METRICS_INTERVAL_MS);
  dbPoolMetricsTimer.unref();
  app.addHook('onClose', async () => clearInterval(dbPoolMetricsTimer));

  app.get('/metrics', async (_request, reply) => {
    reply.header('Content-Type', metrics.registry.contentType);
    return reply.send(await metrics.registry.metrics());
  });

  app.register(productsRoutes, { pool, logger });
  app.register(healthRoutes, { pool, serviceName: SERVICE_NAME });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, path: request.url }, 'unhandled_error');
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
  });

  return app;
}
