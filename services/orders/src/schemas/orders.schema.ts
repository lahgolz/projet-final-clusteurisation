import { z } from 'zod';

export const MAX_ITEMS_PER_ORDER = 50;

export const createOrderItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().positive(),
});

export const createOrderSchema = z.object({
  items: z
    .array(createOrderItemSchema)
    .min(1, 'items must contain at least one entry')
    .max(MAX_ITEMS_PER_ORDER, `items must contain at most ${MAX_ITEMS_PER_ORDER} entries`),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const orderIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type OrderIdParam = z.infer<typeof orderIdParamSchema>;
