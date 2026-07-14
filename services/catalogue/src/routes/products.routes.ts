import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger } from '@microservice-app/shared';
import { listProductsQuerySchema, productIdParamSchema } from '../schemas/products.schema.js';
import { listProducts, getProductById } from '../repositories/products.repository.js';
import { sendError } from '../errors.js';

export interface ProductsRoutesOptions {
  pool: Pool;
  logger: Logger;
}

export async function productsRoutes(
  app: FastifyInstance,
  { pool, logger }: ProductsRoutesOptions,
): Promise<void> {
  app.get('/api/catalogue/products', async (request, reply) => {
    const parsed = listProductsQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Invalid query parameters',
        parsed.error.flatten(),
      );
    }

    try {
      const products = await listProducts(pool, parsed.data.limit, parsed.data.offset);
      return reply.send({ products });
    } catch (error) {
      logger.error({ err: error }, 'failed_to_list_products');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Unable to list products');
    }
  });

  app.get('/api/catalogue/products/:id', async (request, reply) => {
    const parsed = productIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Invalid product id',
        parsed.error.flatten(),
      );
    }

    try {
      const product = await getProductById(pool, parsed.data.id);
      if (!product) {
        return sendError(reply, 404, 'PRODUCT_NOT_FOUND', `Product ${parsed.data.id} not found`);
      }
      return reply.send(product);
    } catch (error) {
      logger.error({ err: error }, 'failed_to_get_product');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Unable to fetch product');
    }
  });
}
