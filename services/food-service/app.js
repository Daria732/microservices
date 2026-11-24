'use strict';
const { randomUUID } = require('node:crypto');
const { createApp } = require('../shared/http');
const { ApiError } = require('../shared/problem');
const { validate } = require('../shared/validate');
const { paginate, requireUser } = require('../shared/util');

// МОК внешнего каталога Open Food Facts: небольшой набор продуктов (КБЖУ на 100 г).
const SOURCE = 'Open Food Facts (mock)';
const SEED = [
  ['product-123', 'Овсяные хлопья', 'Example Brand', 370, 13.2, 6.5, 62],
  ['product-124', 'Куриная грудка отварная', 'Example Brand', 165, 31, 3.6, 0],
  ['product-125', 'Банан', 'Fresh', 89, 1.1, 0.3, 22.8],
  ['product-126', 'Яблоко', 'Fresh', 52, 0.3, 0.2, 13.8],
  ['product-127', 'Рис отварной', 'Example Brand', 130, 2.7, 0.3, 28],
  ['product-128', 'Греческий йогурт', 'Example Brand', 59, 10, 0.4, 3.6],
  ['product-129', 'Гречка отварная', 'Example Brand', 110, 4.2, 1.1, 21.3],
  ['product-130', 'Яйцо куриное', 'Farm', 155, 13, 11, 1.1],
  ['product-131', 'Лосось запечённый', 'Sea', 208, 20, 13, 0],
  ['product-132', 'Творог 5%', 'Example Brand', 121, 17, 5, 1.8],
].map(([productId, name, brand, calories, protein, fat, carbohydrates]) => (
  { productId, name, brand, calories, protein, fat, carbohydrates, source: SOURCE }));

const PANTRY_SCHEMA = {
  productId: { type: 'string', required: true },
  quantity: { type: 'number', required: true, min: 0 },
  unit: { type: 'string', required: true, enum: ['g', 'ml', 'pcs'] },
  expirationDate: { type: 'date', nullable: true },
};
const PANTRY_UPDATE_SCHEMA = {
  quantity: { type: 'number', min: 0 },
  unit: { type: 'string', enum: ['g', 'ml', 'pcs'] },
  expirationDate: { type: 'date', nullable: true },
};

module.exports = function createFoodService(cfg = {}) {
  const app = createApp({ name: 'food-service', logLevel: cfg.logLevel });
  const log = app.log;
  const products = new Map(SEED.map((p) => [p.productId, p])); // food_db
  const pantry = new Map();

  const getProduct = (id) => {
    const p = products.get(id);
    if (!p) throw new ApiError(404, 'RESOURCE_NOT_FOUND', `Продукт ${id} не найден`);
    return p;
  };

  app.get('/api/v1/products', (ctx) => {
    const q = (ctx.query.query || '').toLowerCase().trim();
    const found = [...products.values()].filter((p) => !q || p.name.toLowerCase().includes(q));
    log.info(`поиск продуктов: "${q}"`, { found: found.length });
    return { status: 200, body: paginate(found, ctx.query) };
  });
  app.get('/api/v1/products/:productId', (ctx) => ({ status: 200, body: getProduct(ctx.params.productId) }));
  app.get('/internal/v1/products/:productId', (ctx) => ({ status: 200, body: getProduct(ctx.params.productId) }));

  const mine = (userId) => [...pantry.values()].filter((i) => i.userId === userId);
  const ownItem = (ctx, userId) => {
    const it = pantry.get(ctx.params.itemId);
    if (!it || it.userId !== userId) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Запись о запасах не найдена');
    return it;
  };

  app.get('/api/v1/pantry', (ctx) => ({ status: 200, body: paginate(mine(requireUser(ctx)), ctx.query) }));

  app.post('/api/v1/pantry', (ctx) => {
    const userId = requireUser(ctx);
    const b = validate(ctx.body, PANTRY_SCHEMA);
    getProduct(b.productId);
    const item = {
      itemId: `pantry-${randomUUID().slice(0, 8)}`, userId, productId: b.productId,
      quantity: b.quantity, unit: b.unit, expirationDate: b.expirationDate ?? null,
    };
    pantry.set(item.itemId, item);
    log.info('продукт добавлен в запасы', { itemId: item.itemId, productId: item.productId });
    return { status: 201, body: item };
  }, { idempotent: true });

  app.put('/api/v1/pantry/:itemId', (ctx) => {
    const userId = requireUser(ctx);
    const it = ownItem(ctx, userId);
    const b = validate(ctx.body, PANTRY_UPDATE_SCHEMA, { partial: true });
    const fields = Object.keys(PANTRY_UPDATE_SCHEMA).filter((k) => b[k] !== undefined);
    if (!fields.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Не передано ни одного поля для обновления');
    for (const k of fields) it[k] = b[k];
    return { status: 200, body: it };
  }, { idempotent: true });

  app.delete('/api/v1/pantry/:itemId', (ctx) => {
    const it = ownItem(ctx, requireUser(ctx));
    pantry.delete(it.itemId);
    log.info('продукт удалён из запасов', { itemId: it.itemId });
    return { status: 204 };
  }, { idempotent: true });

  return app;
};
