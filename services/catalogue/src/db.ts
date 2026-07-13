import { Pool } from 'pg';
import type { Config } from './config.js';

export function createPool(
  config: Pick<Config, 'databaseUrl' | 'dbPoolMax' | 'requestTimeoutMs'>,
): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: config.dbPoolMax,
    connectionTimeoutMillis: config.requestTimeoutMs,
    statement_timeout: config.requestTimeoutMs,
    query_timeout: config.requestTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
}

export async function warmPool(pool: Pool, min: number): Promise<void> {
  const clients = [];
  try {
    for (let i = 0; i < min; i += 1) {
      clients.push(await pool.connect());
    }
  } finally {
    for (const client of clients) client.release();
  }
}

export async function checkDbHealth(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
