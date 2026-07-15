import type { ApiErrorBody, CreateOrderInput, Order, Product } from './types';

export const DEFAULT_TIMEOUT_MS = 8000;

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export class ApiError extends Error {
  status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...init?.headers },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new ApiError('La requête a expiré, veuillez réessayer.');
    }
    throw new ApiError('Impossible de contacter le serveur, vérifiez votre connexion.');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let message = `Erreur serveur (${response.status})`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      if (body?.error?.message) message = body.error.message;
    } catch {
      // We already have a fallback message
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
}

export function listProducts(): Promise<{ products: Product[] }> {
  return requestJson('/api/catalogue/products');
}

export function createOrder(input: CreateOrderInput): Promise<Order> {
  return requestJson('/api/orders', { method: 'POST', body: JSON.stringify(input) });
}
