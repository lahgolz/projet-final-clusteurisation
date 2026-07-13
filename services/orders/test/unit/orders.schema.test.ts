import { describe, expect, it } from 'vitest';
import {
  createOrderSchema,
  orderIdParamSchema,
  MAX_ITEMS_PER_ORDER,
} from '../../src/schemas/orders.schema.js';

const validProductId = '11111111-1111-4111-8111-111111111111';

describe('createOrderSchema', () => {
  it('accepts a well-formed payload', () => {
    const result = createOrderSchema.safeParse({
      items: [{ productId: validProductId, quantity: 2 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty items array', () => {
    expect(createOrderSchema.safeParse({ items: [] }).success).toBe(false);
  });

  it('rejects a missing items field', () => {
    expect(createOrderSchema.safeParse({}).success).toBe(false);
  });

  it('rejects a non-uuid productId', () => {
    expect(
      createOrderSchema.safeParse({ items: [{ productId: 'not-a-uuid', quantity: 1 }] }).success,
    ).toBe(false);
  });

  it('rejects a zero quantity', () => {
    expect(
      createOrderSchema.safeParse({ items: [{ productId: validProductId, quantity: 0 }] }).success,
    ).toBe(false);
  });

  it('rejects a negative quantity', () => {
    expect(
      createOrderSchema.safeParse({ items: [{ productId: validProductId, quantity: -1 }] }).success,
    ).toBe(false);
  });

  it('rejects a non-integer quantity', () => {
    expect(
      createOrderSchema.safeParse({ items: [{ productId: validProductId, quantity: 1.5 }] })
        .success,
    ).toBe(false);
  });

  it('rejects a quantity provided as a string', () => {
    expect(
      createOrderSchema.safeParse({ items: [{ productId: validProductId, quantity: '2' }] })
        .success,
    ).toBe(false);
  });

  it('rejects more items than the configured maximum', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_ORDER + 1 }, () => ({
      productId: validProductId,
      quantity: 1,
    }));
    expect(createOrderSchema.safeParse({ items }).success).toBe(false);
  });

  it('accepts exactly the configured maximum number of items', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_ORDER }, () => ({
      productId: validProductId,
      quantity: 1,
    }));
    expect(createOrderSchema.safeParse({ items }).success).toBe(true);
  });
});

describe('orderIdParamSchema', () => {
  it('accepts a valid UUID', () => {
    expect(orderIdParamSchema.safeParse({ id: validProductId }).success).toBe(true);
  });

  it('rejects a non-UUID id', () => {
    expect(orderIdParamSchema.safeParse({ id: 'nope' }).success).toBe(false);
  });
});
