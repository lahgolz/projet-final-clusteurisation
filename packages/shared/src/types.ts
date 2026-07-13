export interface Product {
  id: string;
  name: string;
  description: string | null;
  priceCents: number;
  currency: string;
  stock: number;
  createdAt: string;
  updatedAt: string;
}

export type OrderStatus = 'created' | 'confirmed' | 'cancelled';

export interface OrderItem {
  id: string;
  productId: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  totalCents: number;
  currency: string;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrderItemInput {
  productId: string;
  quantity: number;
}

export interface CreateOrderInput {
  items: CreateOrderItemInput[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface HealthStatus {
  status: 'ok' | 'error';
  service: string;
}
