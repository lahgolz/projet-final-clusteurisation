import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4001),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DB_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
});

export interface Config {
  port: number;
  databaseUrl: string;
  logLevel: string;
  dbPoolMin: number;
  dbPoolMax: number;
  requestTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment configuration: ${parsed.error.message}`);
  }

  const data = parsed.data;
  return {
    port: data.PORT,
    databaseUrl: data.DATABASE_URL,
    logLevel: data.LOG_LEVEL,
    dbPoolMin: data.DB_POOL_MIN,
    dbPoolMax: data.DB_POOL_MAX,
    requestTimeoutMs: data.REQUEST_TIMEOUT_MS,
  };
}
