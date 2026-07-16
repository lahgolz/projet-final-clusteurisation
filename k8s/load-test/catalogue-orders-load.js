import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const CATALOGUE_URL = __ENV.CATALOGUE_URL || 'http://catalogue:4001';
const ORDERS_URL = __ENV.ORDERS_URL || 'http://orders:4002';
const BROWSE_RATIO = Number(__ENV.BROWSE_RATIO || 0.7);

export const options = {
  scenarios: {
    ramping: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: __ENV.RAMP_UP || '30s', target: Number(__ENV.PEAK_VUS || 20) },
        { duration: __ENV.PLATEAU || '60s', target: Number(__ENV.PEAK_VUS || 20) },
        { duration: __ENV.RAMP_DOWN || '30s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
  },
};

const catalogueLatency = new Trend('catalogue_latency_ms', true);
const ordersLatency = new Trend('orders_latency_ms', true);
const errorRate = new Rate('scenario_errors');

export function setup() {
  const res = http.get(`${CATALOGUE_URL}/api/catalogue/products`);
  if (res.status !== 200) {
    throw new Error(`Impossible de récupérer le catalogue au setup (HTTP ${res.status})`);
  }
  const ids = (res.json('products') || []).map((p) => p.id);
  if (ids.length === 0) {
    throw new Error('Catalogue vide : lancer db:seed avant le test de charge');
  }
  return { productIds: ids };
}

function browseCatalogue(ids) {
  const listRes = http.get(`${CATALOGUE_URL}/api/catalogue/products`, {
    tags: { name: 'catalogue_list' },
  });
  catalogueLatency.add(listRes.timings.duration);
  errorRate.add(listRes.status >= 400);
  check(listRes, { 'catalogue list -> 200': (r) => r.status === 200 });

  const id = ids[Math.floor(Math.random() * ids.length)];
  const detailRes = http.get(`${CATALOGUE_URL}/api/catalogue/products/${id}`, {
    tags: { name: 'catalogue_detail' },
  });
  catalogueLatency.add(detailRes.timings.duration);
  errorRate.add(detailRes.status >= 400);
  check(detailRes, { 'catalogue detail -> 200': (r) => r.status === 200 });
}

function createOrder(ids) {
  const id = ids[Math.floor(Math.random() * ids.length)];
  const payload = JSON.stringify({ items: [{ productId: id, quantity: 1 }] });
  const res = http.post(`${ORDERS_URL}/api/orders`, payload, {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'orders_create' },
  });
  ordersLatency.add(res.timings.duration);
  errorRate.add(res.status >= 400);
  check(res, { 'order create -> 201': (r) => r.status === 201 });
}

export default function (data) {
  if (Math.random() < BROWSE_RATIO) {
    browseCatalogue(data.productIds);
  } else {
    createOrder(data.productIds);
  }

  sleep(0.2 + Math.random() * 0.5);
}
