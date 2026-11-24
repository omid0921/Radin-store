import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const server = await readFile(new URL('../src/server.js', import.meta.url), 'utf8');
const auth = await readFile(new URL('../src/auth.js', import.meta.url), 'utf8');

test('login and bootstrap endpoints have request throttling', () => {
  assert.match(server, /app\.post\("\/auth\/login",\s*loginLimiter/);
  assert.match(server, /app\.post\("\/auth\/bootstrap-owner",\s*bootstrapLimiter/);
});

test('owner bootstrap is serialized with a PostgreSQL transaction lock', () => {
  assert.match(server, /pg_advisory_xact_lock\(74192831\)/);
});

test('stock OUT uses a conditional atomic decrement to prevent overselling', () => {
  assert.match(server, /stockQuantity:\s*\{\s*gte:\s*body\.quantity\s*\}/);
  assert.match(server, /stockQuantity:\s*\{\s*decrement:\s*body\.quantity\s*\}/);
});

test('public catalogue selects only retail price and does not expose cost/wholesale prices', () => {
  const start = server.indexOf('app.get("/public/products"');
  const end = server.indexOf('app.get("/admin/products"', start);
  const route = server.slice(start, end);
  assert.match(route, /retailPrice/);
  assert.doesNotMatch(route, /wholesalePrice|purchasePrice/);
});

test('JWT verification is scoped to expected issuer and audience', () => {
  assert.match(auth, /issuer:\s*"radin-store-api"/);
  assert.match(auth, /audience:\s*"radin-admin"/);
});


test('customer order endpoint derives prices from database and does not trust client totals', () => {
  const start = server.indexOf('app.post("/public/orders"');
  const end = server.indexOf('app.get("/admin/orders"', start);
  const route = server.slice(start, end);
  assert.match(route, /v\.retailPrice \* BigInt\(quantity\)/);
  assert.doesNotMatch(route, /body\.total|body\.price|unitPrice:\s*item\./);
  assert.match(route, /stockQuantity:\s*\{\s*gte:\s*line\.quantity\s*\}/);
});

test('order endpoint does not claim payment and creates pending unpaid orders', async () => {
  assert.match(server, /paymentStatus:\s*order\.paymentStatus/);
  const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
  assert.match(schema, /status\s+OrderStatus\s+@default\(PENDING_REVIEW\)/);
  assert.match(schema, /paymentStatus\s+OrderPaymentStatus\s+@default\(UNPAID\)/);
});
