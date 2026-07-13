import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createLogger, logHttpRequest } from './logger.js';

function createCapturingStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { stream, lines };
}

describe('logger', () => {
  it('produces a JSON line with the required HTTP fields', () => {
    const logger = createLogger('catalogue');
    const chunks: string[] = [];
    vi.spyOn(logger, 'info').mockImplementation(((fields: unknown, msg?: string) => {
      chunks.push(JSON.stringify({ ...(fields as object), msg }));
      return logger;
    }) as typeof logger.info);

    logHttpRequest(logger, {
      method: 'GET',
      route: '/api/catalogue/products',
      status: 200,
      durationMs: 12,
      requestId: 'req-1',
    });

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0]!);
    expect(parsed).toMatchObject({
      method: 'GET',
      route: '/api/catalogue/products',
      status: 200,
      durationMs: 12,
      requestId: 'req-1',
    });
  });

  it('redacts sensitive fields instead of logging them in clear', () => {
    const { stream, lines } = createCapturingStream();
    const logger = createLogger('catalogue', 'info', stream);

    logger.info({ password: 'super-secret' }, 'login_attempt');

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.password).toBe('[redacted]');
  });
});
