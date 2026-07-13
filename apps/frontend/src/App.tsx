import { useEffect, useState } from 'react';
import { ApiError, createOrder, listProducts } from './api/client';
import { formatPriceCents } from './api/format';
import type { Product } from './api/types';
import './App.css';

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; products: Product[] };

interface OrderSubmission {
  productId: string;
  status: 'submitting' | 'success' | 'error';
  message: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function App() {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submission, setSubmission] = useState<OrderSubmission | null>(null);

  useEffect(() => {
    let cancelled = false;

    listProducts()
      .then((data) => {
        if (!cancelled) setState({ status: 'success', products: data.products });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: errorMessage(error, 'Erreur inattendue.') });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleOrder(productId: string): Promise<void> {
    const quantity = quantities[productId] ?? 1;
    setSubmission({ productId, status: 'submitting', message: '' });

    try {
      const order = await createOrder({ items: [{ productId, quantity }] });
      setSubmission({
        productId,
        status: 'success',
        message: `Commande ${order.id} créée (${formatPriceCents(order.totalCents, order.currency)}).`,
      });
    } catch (error) {
      setSubmission({
        productId,
        status: 'error',
        message: errorMessage(error, 'Erreur inattendue lors de la commande.'),
      });
    }
  }

  return (
    <main className="app">
      <h1>MicroShop — Catalogue</h1>

      {state.status === 'loading' && <p role="status">Chargement du catalogue…</p>}

      {state.status === 'error' && (
        <p role="alert" className="banner banner-error">
          {state.message}
        </p>
      )}

      {state.status === 'success' && state.products.length === 0 && (
        <p>Aucun produit disponible pour le moment.</p>
      )}

      {state.status === 'success' && state.products.length > 0 && (
        <ul className="product-list">
          {state.products.map((product) => {
            const isSubmittingThis =
              submission?.productId === product.id && submission.status === 'submitting';
            return (
              <li key={product.id} className="product-card">
                <h2>{product.name}</h2>
                {product.description && <p className="description">{product.description}</p>}
                <p className="price">{formatPriceCents(product.priceCents, product.currency)}</p>
                <p className="stock">
                  {product.stock > 0 ? `${product.stock} en stock` : 'Rupture de stock'}
                </p>

                <label className="quantity-label">
                  Quantité
                  <input
                    type="number"
                    min={1}
                    value={quantities[product.id] ?? 1}
                    disabled={product.stock === 0}
                    onChange={(event) =>
                      setQuantities((current) => ({
                        ...current,
                        [product.id]: Math.max(1, Number(event.target.value) || 1),
                      }))
                    }
                  />
                </label>

                <button
                  type="button"
                  onClick={() => void handleOrder(product.id)}
                  disabled={product.stock === 0 || isSubmittingThis}
                >
                  {isSubmittingThis ? 'Envoi…' : 'Commander'}
                </button>

                {submission?.productId === product.id && submission.status === 'success' && (
                  <p role="status" className="banner banner-success">
                    {submission.message}
                  </p>
                )}
                {submission?.productId === product.id && submission.status === 'error' && (
                  <p role="alert" className="banner banner-error">
                    {submission.message}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
