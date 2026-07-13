import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4002),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CATALOGUE_BASE_URL: z.string().url('CATALOGUE_BASE_URL must be a valid URL'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(5000),
  CATALOGUE_TIMEOUT_MS: z.coerce.number().int().positive().default(2000),
});

export interface Config {
  port: number;
  databaseUrl: string;
  catalogueBaseUrl: string;
  logLevel: string;
  requestTimeoutMs: number;
  catalogueTimeoutMs: number;
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
    catalogueBaseUrl: data.CATALOGUE_BASE_URL,
    logLevel: data.LOG_LEVEL,
    requestTimeoutMs: data.REQUEST_TIMEOUT_MS,
    catalogueTimeoutMs: data.CATALOGUE_TIMEOUT_MS,
  };
}
