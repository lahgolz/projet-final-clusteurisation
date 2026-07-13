import { z } from 'zod';

export const listProductsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productIdParamSchema = z.object({
  id: z.string().uuid(),
});

export type ProductIdParam = z.infer<typeof productIdParamSchema>;
