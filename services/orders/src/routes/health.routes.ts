import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { checkDbHealth } from '../db.js';

export interface HealthRoutesOptions {
  pool: Pool;
  serviceName: string;
}

export async function healthRoutes(
  app: FastifyInstance,
  { pool, serviceName }: HealthRoutesOptions,
): Promise<void> {
  app.get('/health/live', async (_request, reply) => {
    return reply.send({ status: 'ok', service: serviceName });
  });

  app.get('/health/ready', async (_request, reply) => {
    const healthy = await checkDbHealth(pool);
    if (!healthy) {
      return reply.status(503).send({ status: 'error', service: serviceName });
    }
    return reply.send({ status: 'ok', service: serviceName });
  });
}
