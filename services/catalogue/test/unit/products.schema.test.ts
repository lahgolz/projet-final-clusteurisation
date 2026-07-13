import { describe, expect, it } from 'vitest';
import {
  listProductsQuerySchema,
  productIdParamSchema,
} from '../../src/schemas/products.schema.js';

describe('listProductsQuerySchema', () => {
  it('applies defaults when no query params are given', () => {
    expect(listProductsQuerySchema.parse({})).toEqual({ limit: 50, offset: 0 });
  });

  it('coerces numeric strings from the query string', () => {
    expect(listProductsQuerySchema.parse({ limit: '10', offset: '5' })).toEqual({
      limit: 10,
      offset: 5,
    });
  });

  it('rejects a limit above the maximum', () => {
    expect(listProductsQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
  });

  it('rejects a negative offset', () => {
    expect(listProductsQuerySchema.safeParse({ offset: '-1' }).success).toBe(false);
  });

  it('rejects a non-numeric limit', () => {
    expect(listProductsQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false);
  });
});

describe('productIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(
      productIdParamSchema.safeParse({ id: '11111111-1111-4111-8111-111111111111' }).success,
    ).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(productIdParamSchema.safeParse({ id: 'not-a-uuid' }).success).toBe(false);
  });
});
