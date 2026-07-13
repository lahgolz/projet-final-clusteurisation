import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runMigration(direction: 'up' | 'down') {
  execFileSync('pnpm', ['exec', 'node-pg-migrate', direction, '-m', 'migrations'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: 'pipe',
  });
}

describeIfDb('migrations on a temporary database', () => {
  it('creates the expected tables on up and removes them on down', async () => {
    const pool = new Pool({ connectionString: testDatabaseUrl });
    try {
      runMigration('up');

      const tables = await pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
      );
      expect(tables.rows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining(['products', 'orders', 'order_items', 'pgmigrations']),
      );

      const columns = await pool.query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'products'`,
      );
      expect(columns.rows.map((r) => r.column_name)).toEqual(
        expect.arrayContaining(['id', 'name', 'price_cents', 'currency', 'stock']),
      );

      runMigration('down');

      const tablesAfterDown = await pool.query<{ table_name: string }>(
        `select table_name from information_schema.tables where table_schema = 'public' and table_name in ('products','orders','order_items')`,
      );
      expect(tablesAfterDown.rows).toHaveLength(0);
    } finally {
      await pool.end();
    }
  }, 30000);
});
