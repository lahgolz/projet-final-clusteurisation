export { createLogger, logHttpRequest } from './logger.js';
export type { Logger, HttpLogFields } from './logger.js';
export { fetchWithTimeout, TimeoutError } from './http.js';
export type { FetchWithTimeoutOptions } from './http.js';
export type {
  Product,
  OrderStatus,
  OrderItem,
  Order,
  CreateOrderItemInput,
  CreateOrderInput,
  ApiErrorBody,
  HealthStatus,
} from './types.js';
