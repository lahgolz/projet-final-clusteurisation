import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { logHttpRequest, type Logger } from '@microservice-app/shared';
import { ordersRoutes } from './routes/orders.routes.js';
import { healthRoutes } from './routes/health.routes.js';
import type { CatalogueClient } from './clients/catalogueClient.js';

declare module 'fastify' {
  interface FastifyRequest {
    startTimeNs: bigint;
  }
}

export interface BuildAppOptions {
  pool: Pool;
  logger: Logger;
  catalogueClient: CatalogueClient;
}

export function buildApp({ pool, logger, catalogueClient }: BuildAppOptions): FastifyInstance {
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    forceCloseConnections: 'idle',
  });

  app.decorateRequest('startTimeNs');

  app.addHook('onRequest', async (request: FastifyRequest) => {
    request.startTimeNs = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    const durationMs = Number((process.hrtime.bigint() - request.startTimeNs) / 1_000_000n);
    logHttpRequest(logger, {
      method: request.method,
      route: request.routeOptions.url ?? request.url,
      status: reply.statusCode,
      durationMs,
      requestId: String(request.id),
    });
  });

  app.register(ordersRoutes, { pool, logger, catalogueClient });
  app.register(healthRoutes, { pool, serviceName: 'orders' });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `Route ${request.method} ${request.url} not found` },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    logger.error({ err: error, route: request.url }, 'unhandled_error');
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected error' } });
  });

  return app;
}
