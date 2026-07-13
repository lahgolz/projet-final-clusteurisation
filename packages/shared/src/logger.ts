import pino from 'pino';

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'body.password',
  'databaseUrl',
  'DATABASE_URL',
];

export interface HttpLogFields {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  requestId: string;
}

export function createLogger(
  service: string,
  level: string = 'info',
  destination?: pino.DestinationStream,
) {
  return pino(
    {
      level,
      base: { service },
      timestamp: pino.stdTimeFunctions.isoTime,
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    },
    destination,
  );
}

export type Logger = ReturnType<typeof createLogger>;

export function logHttpRequest(logger: Logger, fields: HttpLogFields): void {
  logger.info(fields, 'http_request');
}
