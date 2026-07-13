export interface Product {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  stock: number;
}

export interface OrderItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  status: string;
  totalCents: number;
  currency: string;
  items: OrderItem[];
}

export interface CreateOrderInput {
  items: Array<{ productId: string; quantity: number }>;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
