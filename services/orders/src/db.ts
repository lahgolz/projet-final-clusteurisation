import { Pool } from 'pg';
import type { Config } from './config.js';

const DEFAULT_POOL_MAX = 10;

export function createPool(config: Pick<Config, 'databaseUrl' | 'requestTimeoutMs'>): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: DEFAULT_POOL_MAX,
    connectionTimeoutMillis: config.requestTimeoutMs,
    statement_timeout: config.requestTimeoutMs,
    query_timeout: config.requestTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
}

export async function checkDbHealth(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
