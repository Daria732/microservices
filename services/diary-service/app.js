'use strict';
const { randomUUID } = require('node:crypto');
const { createApp } = require('../shared/http');
const { ApiError } = require('../shared/problem');
const { validate } = require('../shared/validate');
const { callService } = require('../shared/client');
const { createEvent, createOutbox, registerConsumer } = require('../shared/events');
const { paginate, requireUser } = require('../shared/util');
const { calcMacros } = require('./calc');

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];
const UNITS = ['g', 'ml'];
const CREATE_SCHEMA = {
  productId: { type: 'string', required: true },
  mealType: { type: 'string', required: true, enum: MEALS },
  quantity: { type: 'number', required: true, min: 0 },
  unit: { type: 'string', required: true, enum: UNITS },
  date: { type: 'date', required: true },
};
const UPDATE_SCHEMA = {
  mealType: { type: 'string', enum: MEALS },
  quantity: { type: 'number', min: 0 },
  unit: { type: 'string', enum: UNITS },
  date: { type: 'date' },
};

module.exports = function createDiaryService(cfg = {}) {
  const app = createApp({ name: 'diary-service', logLevel: cfg.logLevel });
  const log = app.log;
  const foodUrl = cfg.foodUrl || 'http://localhost:3002';
  const entries = new Map(); // diary_db
  const compensations = [];
  const outbox = createOutbox({ brokerUrl: cfg.brokerUrl, log, intervalMs: cfg.outboxIntervalMs });
  app.onClose(() => outbox.stop());
  app.entries = entries;
  app.outbox = outbox;

  const toPublic = (e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_')));
  const eventPayload = (e) => ({
    entryId: e.entryId, userId: e.userId, productId: e.productId, mealType: e.mealType,
    quantity: e.quantity, unit: e.unit, calories: e.calories, protein: e.protein,
    fat: e.fat, carbohydrates: e.carbohydrates, date: e.date,
  });
  const ownEntry = (ctx, userId) => {
    const e = entries.get(ctx.params.entryId);
    if (!e || e.userId !== userId) throw new ApiError(404, 'ENTRY_NOT_FOUND', 'Запись дневника не найдена');
    return e;
  };

  // --- публичный API ---
  app.get('/api/v1/diary/entries', (ctx) => {
    const userId = requireUser(ctx);
    let list = [...entries.values()].filter((e) => e.userId === userId);
    if (ctx.query.date) list = list.filter((e) => e.date === ctx.query.date);
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const page = paginate(list, ctx.query);
    return { status: 200, body: { ...page, items: page.items.map(toPublic) } };
  });

  app.post('/api/v1/diary/entries', async (ctx) => {
    const userId = requireUser(ctx);
    const b = validate(ctx.body, CREATE_SCHEMA);

    // синхронное взаимодействие №1: diary -> food (КБЖУ продукта)
    const r = await callService({
      target: 'food-service', baseUrl: foodUrl, caller: 'diary-service', log,
      path: `/internal/v1/products/${encodeURIComponent(b.productId)}`,
    });
    if (r.status === 404) throw new ApiError(404, 'PRODUCT_NOT_FOUND', `Продукт ${b.productId} не найден`);
    if (r.status !== 200) throw new ApiError(502, 'UPSTREAM_ERROR', 'Некорректный ответ food-service');
    const product = r.body;

    const entry = {
      entryId: `entry-${randomUUID().slice(0, 8)}`, userId, productId: b.productId,
      mealType: b.mealType, quantity: b.quantity, unit: b.unit,
      ...calcMacros(product, b.quantity), date: b.date, createdAt: new Date().toISOString(),
      _per100: { calories: product.calories, protein: product.protein, fat: product.fat, carbohydrates: product.carbohydrates },
    };
    // «транзакция»: запись + событие в outbox
    entries.set(entry.entryId, entry);
    outbox.add(createEvent('MealEntryCreated', eventPayload(entry)));
    log.info('запись дневника создана', { entryId: entry.entryId, calories: entry.calories });
    return { status: 201, body: toPublic(entry) };
  }, { idempotent: true });

  app.get('/api/v1/diary/entries/:entryId', (ctx) => ({ status: 200, body: toPublic(ownEntry(ctx, requireUser(ctx))) }));

  app.put('/api/v1/diary/entries/:entryId', (ctx) => {
    const e = ownEntry(ctx, requireUser(ctx));
    const b = validate(ctx.body, UPDATE_SCHEMA, { partial: true });
    const fields = Object.keys(UPDATE_SCHEMA).filter((k) => b[k] !== undefined);
    if (!fields.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Не передано ни одного поля для обновления');
    for (const k of fields) e[k] = b[k];
    Object.assign(e, calcMacros(e._per100, e.quantity));
    outbox.add(createEvent('MealEntryUpdated', eventPayload(e)));
    log.info('запись дневника изменена', { entryId: e.entryId, fields });
    return { status: 200, body: toPublic(e) };
  }, { idempotent: true });

  app.delete('/api/v1/diary/entries/:entryId', (ctx) => {
    const e = ownEntry(ctx, requireUser(ctx));
    entries.delete(e.entryId);
    outbox.add(createEvent('MealEntryDeleted', { entryId: e.entryId, userId: e.userId, date: e.date }));
    log.info('запись дневника удалена', { entryId: e.entryId });
    return { status: 204 };
  }, { idempotent: true });

  app.get('/internal/v1/diary/entries/:entryId', (ctx) => {
    const e = entries.get(ctx.params.entryId);
    if (!e) throw new ApiError(404, 'ENTRY_NOT_FOUND', 'Запись дневника не найдена');
    return { status: 200, body: toPublic(e) };
  });

  // --- служебный эндпоинт для демонстрации (не часть контракта) ---
  app.get('/admin/compensations', () => ({ status: 200, body: { items: compensations, total: compensations.length } }));

  // --- компенсирующее действие саги ---
  // Если nutrition-service так и не смог обработать MealEntryCreated (исчерпаны повторы),
  // брокер присылает MealEntryCreated.DeadLettered -> откатываем запись дневника.
  registerConsumer(app, {
    brokerUrl: cfg.brokerUrl, selfUrl: cfg.selfUrl, queue: 'diary-service.compensation',
    handlers: {
      'MealEntryCreated.DeadLettered': async (p) => {
        const original = p.event;
        if (p.queue !== 'nutrition-service' || !original || original.eventType !== 'MealEntryCreated') return;
        const entry = entries.get(original.payload.entryId);
        if (!entry) { log.info('COMPENSATION: запись уже отсутствует, ничего не делаю'); return; }
        entries.delete(entry.entryId);
        compensations.push({
          entryId: entry.entryId, userId: entry.userId, reason: p.lastError,
          attempts: p.attempts, compensatedAt: new Date().toISOString(),
        });
        log.warn(`COMPENSATION: nutrition-service не смог обработать запись за ${p.attempts} попыток — запись ${entry.entryId} откатана (удалена из дневника)`, { lastError: p.lastError });
      },
    },
  });

  return app;
};
