import type { Pool } from 'pg';
import type { Order, OrderItem, OrderStatus } from '@microshop/shared';

interface OrderRow {
  id: string;
  status: string;
  total_cents: number;
  currency: string;
  created_at: Date;
  updated_at: Date;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderItemToInsert {
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

function toOrder(row: OrderRow, itemRows: OrderItemRow[]): Order {
  const items: OrderItem[] = itemRows.map((r) => ({
    id: r.id,
    productId: r.product_id,
    quantity: r.quantity,
    unitPriceCents: r.unit_price_cents,
  }));

  return {
    id: row.id,
    status: row.status as OrderStatus,
    totalCents: row.total_cents,
    currency: row.currency,
    items,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function createOrder(pool: Pool, items: OrderItemToInsert[]): Promise<Order> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const totalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.quantity, 0);

    const orderResult = await client.query<OrderRow>(
      `INSERT INTO orders (total_cents, currency)
       VALUES ($1, 'EUR')
       RETURNING id, status, total_cents, currency, created_at, updated_at`,
      [totalCents],
    );
    const orderRow = orderResult.rows[0];
    if (!orderRow) {
      throw new Error('order insert did not return a row');
    }

    const itemRows: OrderItemRow[] = [];
    for (const item of items) {
      const itemResult = await client.query<OrderItemRow>(
        `INSERT INTO order_items (order_id, product_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)
         RETURNING id, order_id, product_id, quantity, unit_price_cents`,
        [orderRow.id, item.productId, item.quantity, item.unitPriceCents],
      );
      const itemRow = itemResult.rows[0];
      if (!itemRow) {
        throw new Error('order_item insert did not return a row');
      }
      itemRows.push(itemRow);
    }

    await client.query('COMMIT');
    return toOrder(orderRow, itemRows);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getOrderById(pool: Pool, id: string): Promise<Order | null> {
  const orderResult = await pool.query<OrderRow>(
    `SELECT id, status, total_cents, currency, created_at, updated_at FROM orders WHERE id = $1`,
    [id],
  );
  const orderRow = orderResult.rows[0];
  if (!orderRow) return null;

  const itemsResult = await pool.query<OrderItemRow>(
    `SELECT id, order_id, product_id, quantity, unit_price_cents
     FROM order_items WHERE order_id = $1 ORDER BY id`,
    [id],
  );

  return toOrder(orderRow, itemsResult.rows);
}
