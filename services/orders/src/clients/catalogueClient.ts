import { fetchWithTimeout, TimeoutError, type Product } from '@microshop/shared';

export class ProductNotFoundError extends Error {
  productId: string;

  constructor(productId: string) {
    super(`Product ${productId} not found`);
    this.name = 'ProductNotFoundError';
    this.productId = productId;
  }
}

export class CatalogueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogueUnavailableError';
  }
}

export interface CatalogueClient {
  getProduct(productId: string): Promise<Product>;
}

export interface CatalogueClientOptions {
  baseUrl: string;
  timeoutMs: number;
}

export function createCatalogueClient({
  baseUrl,
  timeoutMs,
}: CatalogueClientOptions): CatalogueClient {
  return {
    async getProduct(productId: string): Promise<Product> {
      let response: Response;
      try {
        response = await fetchWithTimeout(`${baseUrl}/api/catalogue/products/${productId}`, {
          method: 'GET',
          timeoutMs,
          headers: { accept: 'application/json' },
        });
      } catch (error) {
        if (error instanceof TimeoutError) {
          throw new CatalogueUnavailableError(
            `Timed out calling catalogue for product ${productId}`,
          );
        }
        throw new CatalogueUnavailableError(
          `Failed to reach catalogue for product ${productId}: ${(error as Error).message}`,
        );
      }

      if (response.status === 404) {
        throw new ProductNotFoundError(productId);
      }
      if (!response.ok) {
        throw new CatalogueUnavailableError(
          `Catalogue responded with status ${response.status} for product ${productId}`,
        );
      }

      return (await response.json()) as Product;
    },
  };
}
