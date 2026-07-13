import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';

const sampleProduct = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Clavier mécanique',
  description: 'Switches rouges',
  priceCents: 4990,
  currency: 'EUR',
  stock: 10,
};

function stubFetchSequence(handlers: Array<() => Response | Promise<Response>>): void {
  let call = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      const handler = handlers[Math.min(call, handlers.length - 1)]!;
      call += 1;
      return Promise.resolve(handler());
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App', () => {
  it('renders the product list fetched from the catalogue API', async () => {
    stubFetchSequence([
      () => new Response(JSON.stringify({ products: [sampleProduct] }), { status: 200 }),
    ]);

    render(<App />);

    expect(await screen.findByText('Clavier mécanique')).toBeInTheDocument();
    expect(screen.getByText(/49,90/)).toBeInTheDocument();
    expect(screen.getByText('10 en stock')).toBeInTheDocument();
  });

  it('shows an empty-state message when the catalogue has no products', async () => {
    stubFetchSequence([() => new Response(JSON.stringify({ products: [] }), { status: 200 })]);

    render(<App />);

    expect(await screen.findByText('Aucun produit disponible pour le moment.')).toBeInTheDocument();
  });

  it('shows an error message when the catalogue call fails', async () => {
    stubFetchSequence([
      () =>
        new Response(
          JSON.stringify({ error: { code: 'INTERNAL_ERROR', message: 'Panne serveur' } }),
          {
            status: 500,
          },
        ),
    ]);

    render(<App />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Panne serveur');
  });

  it('creates an order and shows a confirmation when clicking "Commander"', async () => {
    const user = userEvent.setup();
    stubFetchSequence([
      () => new Response(JSON.stringify({ products: [sampleProduct] }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            id: '22222222-2222-4222-8222-222222222222',
            status: 'created',
            totalCents: 4990,
            currency: 'EUR',
            items: [{ id: 'x', productId: sampleProduct.id, quantity: 1, unitPriceCents: 4990 }],
          }),
          { status: 201 },
        ),
    ]);

    render(<App />);
    await screen.findByText('Clavier mécanique');

    await user.click(screen.getByRole('button', { name: /commander/i }));

    expect(await screen.findByText(/commande .* créée/i)).toBeInTheDocument();
  });

  it('shows an inline error when creating an order fails', async () => {
    const user = userEvent.setup();
    stubFetchSequence([
      () => new Response(JSON.stringify({ products: [sampleProduct] }), { status: 200 }),
      () =>
        new Response(
          JSON.stringify({
            error: { code: 'CATALOGUE_UNAVAILABLE', message: 'Service indisponible' },
          }),
          {
            status: 502,
          },
        ),
    ]);

    render(<App />);
    await screen.findByText('Clavier mécanique');

    await user.click(screen.getByRole('button', { name: /commander/i }));

    expect(await screen.findByText('Service indisponible')).toBeInTheDocument();
  });
});
