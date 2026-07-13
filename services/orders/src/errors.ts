import type { FastifyReply } from 'fastify';

export function sendError(
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
): FastifyReply {
  return reply
    .status(status)
    .send({ error: { code, message, ...(details !== undefined ? { details } : {}) } });
}
