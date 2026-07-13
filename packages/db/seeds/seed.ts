import { Pool } from 'pg';

interface SeedProduct {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  stock: number;
}

const products: SeedProduct[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Clavier mécanique',
    description: 'Clavier mécanique rétroéclairé, switches rouges',
    priceCents: 4990,
    stock: 25,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Souris sans fil',
    description: 'Souris ergonomique sans fil, 3 boutons',
    priceCents: 2990,
    stock: 40,
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Écran 27 pouces',
    description: 'Écran IPS 27" 2560x1440 75Hz',
    priceCents: 18900,
    stock: 10,
  },
  {
    id: '44444444-4444-4444-8444-444444444444',
    name: 'Casque audio',
    description: 'Casque filaire avec micro amovible',
    priceCents: 7990,
    stock: 15,
  },
  {
    id: '55555555-5555-4555-8555-555555555555',
    name: 'Webcam HD',
    description: 'Webcam 1080p avec cache obturateur',
    priceCents: 3490,
    stock: 30,
  },
];

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to run the seed');
  }

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    for (const product of products) {
      await pool.query(
        `INSERT INTO products (id, name, description, price_cents, currency, stock)
         VALUES ($1, $2, $3, $4, 'EUR', $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           price_cents = EXCLUDED.price_cents,
           stock = EXCLUDED.stock`,
        [product.id, product.name, product.description, product.priceCents, product.stock],
      );
    }

    console.log(JSON.stringify({ level: 'info', msg: 'seed_completed', count: products.length }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', msg: 'seed_failed', error: String(error) }));
  process.exitCode = 1;
});
