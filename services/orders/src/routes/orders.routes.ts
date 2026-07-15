import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Logger, Product } from '@microservice-app/shared';
import { createOrderSchema, orderIdParamSchema } from '../schemas/orders.schema.js';
import { createOrder, getOrderById } from '../repositories/orders.repository.js';
import { sendError } from '../errors.js';
import { ProductNotFoundError, type CatalogueClient } from '../clients/catalogueClient.js';

export interface OrdersRoutesOptions {
  pool: Pool;
  logger: Logger;
  catalogueClient: CatalogueClient;
}

export async function ordersRoutes(
  app: FastifyInstance,
  { pool, logger, catalogueClient }: OrdersRoutesOptions,
): Promise<void> {
  app.post('/api/orders', async (request, reply) => {
    const parsed = createOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(
        reply,
        400,
        'VALIDATION_ERROR',
        'Invalid order payload',
        parsed.error.flatten(),
      );
    }

    const uniqueProductIds = [...new Set(parsed.data.items.map((item) => item.productId))];
    const productsById = new Map<string, Product>();

    try {
      const products = await Promise.all(
        uniqueProductIds.map((id) => catalogueClient.getProduct(id, String(request.id))),
      );
      products.forEach((product, index) => {
        const productId = uniqueProductIds[index];
        if (productId) productsById.set(productId, product);
      });
    } catch (error) {
      if (error instanceof ProductNotFoundError) {
        return sendError(reply, 404, 'PRODUCT_NOT_FOUND', error.message, {
          productId: error.productId,
        });
      }
      logger.error({ err: error }, 'catalogue_unavailable');
      return sendError(reply, 502, 'CATALOGUE_UNAVAILABLE', 'Catalogue service is unavailable');
    }

    const itemsToInsert = parsed.data.items.map((item) => {
      const product = productsById.get(item.productId);
      if (!product) {
        throw new Error(`Invariant violation: no product resolved for ${item.productId}`);
      }
      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPriceCents: product.priceCents,
      };
    });

    try {
      const order = await createOrder(pool, itemsToInsert);
      return reply.status(201).send(order);
    } catch (error) {
      logger.error({ err: error }, 'failed_to_create_order');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Unable to create order');
    }
  });

  app.get('/api/orders/:id', async (request, reply) => {
    const parsed = orderIdParamSchema.safeParse(request.params);
    if (!parsed.success) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid order id', parsed.error.flatten());
    }

    try {
      const order = await getOrderById(pool, parsed.data.id);
      if (!order) {
        return sendError(reply, 404, 'ORDER_NOT_FOUND', `Order ${parsed.data.id} not found`);
      }
      return reply.send(order);
    } catch (error) {
      logger.error({ err: error }, 'failed_to_get_order');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Unable to fetch order');
    }
  });
}
