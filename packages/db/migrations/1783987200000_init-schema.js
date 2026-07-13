exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.createExtension('pgcrypto', { ifNotExists: true });

  pgm.createFunction(
    'set_updated_at',
    [],
    { returns: 'trigger', language: 'plpgsql', replace: true },
    `
    BEGIN
      NEW.updated_at = now();
      RETURN NEW;
    END;
    `,
  );

  pgm.createTable('products', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    name: { type: 'text', notNull: true },
    description: { type: 'text' },
    price_cents: { type: 'integer', notNull: true, check: 'price_cents >= 0' },
    currency: { type: 'text', notNull: true, default: 'EUR' },
    stock: { type: 'integer', notNull: true, default: 0, check: 'stock >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('products', 'name');

  pgm.createTrigger('products', 'set_products_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable('orders', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'created',
      check: "status in ('created', 'confirmed', 'cancelled')",
    },
    total_cents: { type: 'integer', notNull: true, check: 'total_cents >= 0' },
    currency: { type: 'text', notNull: true, default: 'EUR' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('orders', 'created_at');

  pgm.createTrigger('orders', 'set_orders_updated_at', {
    when: 'BEFORE',
    operation: 'UPDATE',
    level: 'ROW',
    function: 'set_updated_at',
  });

  pgm.createTable('order_items', {
    id: {
      type: 'uuid',
      primaryKey: true,
      default: pgm.func('gen_random_uuid()'),
    },
    order_id: {
      type: 'uuid',
      notNull: true,
      references: 'orders',
      onDelete: 'CASCADE',
    },
    product_id: {
      type: 'uuid',
      notNull: true,
      references: 'products',
    },
    quantity: { type: 'integer', notNull: true, check: 'quantity > 0' },
    unit_price_cents: { type: 'integer', notNull: true, check: 'unit_price_cents >= 0' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('order_items', 'order_id');
  pgm.createIndex('order_items', 'product_id');
};

exports.down = (pgm) => {
  pgm.dropTable('order_items');
  pgm.dropTrigger('orders', 'set_orders_updated_at');
  pgm.dropTable('orders');
  pgm.dropTrigger('products', 'set_products_updated_at');
  pgm.dropTable('products');
  pgm.dropFunction('set_updated_at', []);
};
