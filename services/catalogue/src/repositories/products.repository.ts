import type { Pool } from 'pg';
import type { Product } from '@microshop/shared';

interface ProductRow {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  stock: number;
  created_at: Date;
  updated_at: Date;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    priceCents: row.price_cents,
    currency: row.currency,
    stock: row.stock,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const SELECT_COLUMNS =
  'id, name, description, price_cents, currency, stock, created_at, updated_at';

export async function listProducts(pool: Pool, limit: number, offset: number): Promise<Product[]> {
  const result = await pool.query<ProductRow>(
    `SELECT ${SELECT_COLUMNS} FROM products ORDER BY created_at ASC, id ASC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows.map(toProduct);
}

export async function getProductById(pool: Pool, id: string): Promise<Product | null> {
  const result = await pool.query<ProductRow>(
    `SELECT ${SELECT_COLUMNS} FROM products WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? toProduct(row) : null;
}
