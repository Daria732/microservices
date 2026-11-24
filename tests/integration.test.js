'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { startSystem, client, waitFor } = require('./helpers');
const createBroker = require('../mocks/message-broker/broker');
const { createEvent } = require('../services/shared/events');

const DATE = '2026-11-24';
const PROFILE = { userId: 'user-1', age: 21, gender: 'female', height: 173, weight: 60, activityLevel: 'low', goal: 'weight_loss' };
const ENTRY = { productId: 'product-123', mealType: 'breakfast', quantity: 100, unit: 'g', date: DATE };
let n = 0;
const key = () => `key-${Date.now()}-${n++}`;

test('интеграция: вся система через API Gateway', async (t) => {
  const sys = await startSystem({ retryDelayMs: 80, maxAttempts: 5 });
  t.after(() => sys.stop());
  const api = client(sys.gateway.baseUrl, 'user-1');
  const other = client(sys.gateway.baseUrl, 'user-2');

  await t.test('Gateway: без токена 401, внутренние маршруты скрыты, нереализованные сервисы дают 501', async () => {
    const r1 = await api('GET', '/api/v1/products', { token: '' });
    assert.equal(r1.status, 401);
    assert.equal(r1.body.code, 'UNAUTHORIZED');
    assert.match(r1.headers.get('content-type'), /problem\+json/);
    const r2 = await api('GET', '/internal/v1/products/product-123');
    assert.equal(r2.status, 404);
    assert.equal((await api('GET', '/api/v1/recipes')).status, 501);
    const adminDenied = await api('GET', '/admin/broker/queues');
    assert.equal(adminDenied.status, 403);
    const oldOpenChaosRoute = await api('GET', '/admin/chaos');
    assert.equal(oldOpenChaosRoute.status, 403);
    const admin = client(sys.gateway.baseUrl, 'admin');
    const queues = await admin('GET', '/admin/broker/queues');
    assert.equal(queues.status, 200);
    const chaosDown = await admin('POST', '/admin/services/food/chaos', { body: { mode: 'down' } });
    assert.equal(chaosDown.status, 200);
    assert.equal(chaosDown.body.chaos.mode, 'down');
    const chaosUp = await admin('POST', '/admin/services/food/chaos', { body: { mode: 'ok' } });
    assert.equal(chaosUp.status, 200);
    assert.equal(chaosUp.body.chaos.mode, 'ok');
  });

  await t.test('синхронный сценарий: поиск продуктов через food-service', async () => {
    const r = await api('GET', '/api/v1/products?query=овсян');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 1);
    assert.equal(r.body.items[0].productId, 'product-123');
  });

  await t.test('profile: создание, дубликат 409, идемпотентный повтор, валидация, чужой профиль 403', async () => {
    const k = key();
    const c1 = await api('POST', '/api/v1/profiles', { body: PROFILE, key: k });
    assert.equal(c1.status, 201);
    const c2 = await api('POST', '/api/v1/profiles', { body: PROFILE, key: k });
    assert.equal(c2.status, 201);
    assert.equal(c2.headers.get('idempotent-replayed'), 'true');
    assert.equal((await api('POST', '/api/v1/profiles', { body: PROFILE, key: key() })).status, 409);
    const bad = await api('POST', '/api/v1/profiles', { body: { ...PROFILE, userId: 'user-1', age: 5 }, key: key() });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'VALIDATION_ERROR');
    assert.equal((await api('POST', '/api/v1/profiles', { body: PROFILE })).body.code, 'IDEMPOTENCY_KEY_REQUIRED');
    assert.equal((await other('GET', '/api/v1/profiles/user-1')).status, 403);
  });

  await t.test('nutrition: нормы рассчитываются по профилю из profile-service (sync nutrition → profile)', async () => {
    const r = await api('GET', '/api/v1/nutrition/norms');
    assert.equal(r.status, 200);
    assert.equal(r.body.dailyCalories, 1444);
    assert.equal((await other('GET', '/api/v1/nutrition/norms')).status, 404);
  });

  let entryId;
  await t.test('HAPPY PATH: запись дневника -> событие -> сводка -> рекомендация', async () => {
    const k = key();
    const created = await api('POST', '/api/v1/diary/entries', { body: ENTRY, key: k });
    assert.equal(created.status, 201);
    assert.equal(created.body.calories, 370);
    entryId = created.body.entryId;

    // идемпотентность: тот же ключ -> та же запись, дубликата нет
    const replay = await api('POST', '/api/v1/diary/entries', { body: ENTRY, key: k });
    assert.equal(replay.body.entryId, entryId);
    assert.equal(replay.headers.get('idempotent-replayed'), 'true');
    assert.equal((await api('POST', '/api/v1/diary/entries', { body: { ...ENTRY, quantity: 50 }, key: k })).status, 422);
    assert.equal((await api('GET', `/api/v1/diary/entries?date=${DATE}`)).body.total, 1);

    const summary = await waitFor(async () => {
      const r = await api('GET', `/api/v1/nutrition/daily-summary?date=${DATE}`);
      return r.body.consumedCalories === 370 ? r.body : null;
    });
    assert.equal(summary.dailyCaloriesGoal, 1444);
    assert.equal(summary.remainingCalories, 1074);

    const recs = await waitFor(async () => {
      const r = await api('GET', '/api/v1/recommendations?type=nutrition');
      return r.body.total > 0 ? r.body : null;
    });
    assert.equal(recs.items[0].title, 'Увеличьте потребление белка');
    assert.equal(recs.items[0].status, 'new');
    const patched = await api('PATCH', `/api/v1/recommendations/${recs.items[0].recommendationId}`, { body: { status: 'viewed' }, key: key() });
    assert.equal(patched.body.status, 'viewed');
  });

  await t.test('изменение и удаление записи пересчитывают сводку', async () => {
    const upd = await api('PUT', `/api/v1/diary/entries/${entryId}`, { body: { quantity: 200 }, key: key() });
    assert.equal(upd.body.calories, 740);
    await waitFor(async () => (await api('GET', `/api/v1/nutrition/daily-summary?date=${DATE}`)).body.consumedCalories === 740);
    assert.equal((await api('DELETE', `/api/v1/diary/entries/${entryId}`, { key: key() })).status, 204);
    await waitFor(async () => (await api('GET', `/api/v1/nutrition/daily-summary?date=${DATE}`)).body.consumedCalories === 0);
    assert.equal((await api('GET', `/api/v1/diary/entries/${entryId}`)).status, 404);
  });

  await t.test('ОШИБКИ: продукт не найден 404, валидация 400, формат Problem Details', async () => {
    const nf = await api('POST', '/api/v1/diary/entries', { body: { ...ENTRY, productId: 'nope' }, key: key() });
    assert.equal(nf.status, 404);
    assert.equal(nf.body.code, 'PRODUCT_NOT_FOUND');
    assert.equal(nf.body.status, 404);
    assert.ok(nf.body.type && nf.body.title && nf.body.detail && nf.body.instance);
    const bad = await api('POST', '/api/v1/diary/entries', { body: { ...ENTRY, mealType: 'brunch' }, key: key() });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.details.errors[0].field, 'mealType');
  });

  await t.test('СБОЙ (синхронный): food-service недоступен -> 503, запись не создаётся, событие не публикуется', async () => {
    sys.food.chaos = { mode: 'down', latencyMs: 0 };
    const before = sys.diary.entries.size;
    const r = await api('POST', '/api/v1/diary/entries', { body: ENTRY, key: key() });
    sys.food.chaos = { mode: 'ok', latencyMs: 0 };
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'SERVICE_UNAVAILABLE');
    assert.equal(sys.diary.entries.size, before);
    assert.equal(sys.diary.outbox.pending(), 0);
  });

  await t.test('СБОЙ (асинхронный): nutrition недоступен -> повторная доставка -> данные синхронизируются', async () => {
    sys.nutrition.chaos = { mode: 'down', latencyMs: 0 };
    const created = await api('POST', '/api/v1/diary/entries', { body: { ...ENTRY, date: '2026-11-25' }, key: key() });
    assert.equal(created.status, 201); // пользователь не ждёт nutrition
    await waitFor(() => sys.broker.queues.get('nutrition-service').stats.retried >= 1);
    assert.equal((await api('GET', '/api/v1/nutrition/daily-summary?date=2026-11-25')).status, 503); // сервис «лежит»
    assert.equal(sys.nutrition.summaries.has('user-1|2026-11-25'), false); // событие ещё не применено
    sys.nutrition.chaos = { mode: 'ok', latencyMs: 0 };
    await waitFor(async () => (await api('GET', '/api/v1/nutrition/daily-summary?date=2026-11-25')).body.consumedCalories === 370);
    assert.equal(sys.broker.dlq.length, 0);
  });

  await t.test('САГА + КОМПЕНСАЦИЯ: nutrition не восстановился -> DLQ -> запись дневника откатывается', async () => {
    sys.nutrition.chaos = { mode: 'down', latencyMs: 0 };
    const created = await api('POST', '/api/v1/diary/entries', { body: { ...ENTRY, date: '2026-11-26' }, key: key() });
    assert.equal(created.status, 201);
    const id = created.body.entryId;
    assert.equal((await api('GET', `/api/v1/diary/entries/${id}`)).status, 200);

    await waitFor(() => sys.broker.dlq.length === 1);
    assert.equal(sys.broker.dlq[0].queue, 'nutrition-service');
    await waitFor(async () => (await api('GET', `/api/v1/diary/entries/${id}`)).status === 404); // компенсация выполнена
    const admin = client(sys.gateway.baseUrl, 'admin');
    const comp = (await admin('GET', '/admin/diary/compensations')).body;
    assert.ok(comp.items.some((c) => c.entryId === id));
    sys.nutrition.chaos = { mode: 'ok', latencyMs: 0 };
  });

  await t.test('дубликат события не применяется дважды (идемпотентный потребитель)', async () => {
    const ev = createEvent('MealEntryCreated', {
      entryId: 'entry-dup', userId: 'user-1', productId: 'product-123', mealType: 'lunch',
      quantity: 100, unit: 'g', calories: 100, protein: 5, fat: 1, carbohydrates: 10, date: '2026-12-01',
    });
    const send = () => fetch(`${sys.nutrition.baseUrl}/internal/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ev) });
    assert.equal((await send()).status, 200);
    assert.equal((await (await send()).json()).status, 'duplicate');
    assert.equal(sys.nutrition.summaries.get('user-1|2026-12-01').consumedCalories, 100);
  });
});

test('интеграция: брокер — повторы и Dead Letter Queue (глухой потребитель)', async (t) => {
  const broker = await createBroker({ retryDelayMs: 20, maxAttempts: 3, logLevel: 'silent' }).listen(0);
  let hits = 0;
  const consumer = http.createServer((req, res) => { req.resume(); hits += 1; res.writeHead(500); res.end(); });
  await new Promise((r) => consumer.listen(0, r));
  t.after(async () => { consumer.closeAllConnections(); consumer.close(); await broker.close(); });

  await fetch(`${broker.baseUrl}/subscriptions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queue: 'q', eventTypes: ['Ping'], callbackUrl: `http://localhost:${consumer.address().port}/e` }),
  });
  const pub = await fetch(`${broker.baseUrl}/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createEvent('Ping', { a: 1 })) });
  assert.equal(pub.status, 202);
  await waitFor(() => broker.dlq.length === 1);
  assert.equal(hits, 3);
  assert.equal(broker.dlq[0].attempts, 3);
});
