'use strict';
const { randomUUID } = require('node:crypto');
const { createApp } = require('../shared/http');
const { ApiError } = require('../shared/problem');
const { validate } = require('../shared/validate');
const { callService } = require('../shared/client');
const { createEvent, createOutbox, registerConsumer } = require('../shared/events');
const { paginate, requireUser, today } = require('../shared/util');
const { evaluate, activityTip } = require('./rules');

const TYPES = ['nutrition', 'activity', 'general'];
const STATUSES = ['new', 'viewed', 'dismissed', 'completed'];

module.exports = function createRecommendationService(cfg = {}) {
  const app = createApp({ name: 'recommendation-service', logLevel: cfg.logLevel });
  const log = app.log;
  const nutritionUrl = cfg.nutritionUrl || 'http://localhost:3004';
  const profileUrl = cfg.profileUrl || 'http://localhost:3001';
  const recs = new Map();      // recommendation_db
  const ruleIndex = new Map(); // `${userId}|${scope}|${ruleKey}` -> recommendationId
  const outbox = createOutbox({ brokerUrl: cfg.brokerUrl, log, intervalMs: cfg.outboxIntervalMs });
  app.onClose(() => outbox.stop());
  app.recs = recs;

  function upsert(userId, scope, r) {
    const idxKey = `${userId}|${scope}|${r.key}`;
    const now = new Date().toISOString();
    const existingId = ruleIndex.get(idxKey);
    if (existingId) {
      const e = recs.get(existingId);
      Object.assign(e, { title: r.title, description: r.description, reason: r.reason, updatedAt: now });
      log.info(`рекомендация обновлена: ${r.title}`, { recommendationId: e.recommendationId });
      return e;
    }
    const rec = {
      recommendationId: `recommendation-${randomUUID().slice(0, 8)}`, userId, type: r.type,
      title: r.title, description: r.description, reason: r.reason, status: 'new', createdAt: now, updatedAt: now,
    };
    recs.set(rec.recommendationId, rec);
    ruleIndex.set(idxKey, rec.recommendationId);
    log.info(`рекомендация сформирована: ${r.title}`, { recommendationId: rec.recommendationId, type: rec.type });
    outbox.add(createEvent('RecommendationGenerated', {
      recommendationId: rec.recommendationId, userId, type: rec.type, title: rec.title, createdAt: rec.createdAt,
    }));
    return rec;
  }

  async function goalFor(userId, date) {
    try {
      const r = await callService({
        target: 'nutrition-service', baseUrl: nutritionUrl, caller: 'recommendation-service', log,
        path: `/internal/v1/nutrition/daily-summary?userId=${encodeURIComponent(userId)}&date=${date}`,
      });
      return r.status === 200 ? r.body : null;
    } catch (e) {
      log.warn('сводка питания недоступна — оцениваю без цели по калориям');
      return null;
    }
  }

  async function runGeneration(userId, types) {
    for (const type of types) {
      try {
        if (type === 'nutrition') {
          const s = await goalFor(userId, today());
          if (!s) { log.info('нет данных о питании за сегодня — нечего анализировать'); continue; }
          evaluate({ summary: s, goal: s.dailyCaloriesGoal }).forEach((r) => upsert(userId, s.date, r));
        } else if (type === 'activity') {
          const r = await callService({
            target: 'profile-service', baseUrl: profileUrl, caller: 'recommendation-service', log,
            path: `/internal/v1/profiles/${encodeURIComponent(userId)}`,
          });
          if (r.status === 200) upsert(userId, 'static', activityTip(r.body));
        } else {
          upsert(userId, 'static', {
            key: 'general_water', type: 'general', title: 'Пейте достаточно воды',
            description: 'Старайтесь выпивать около 30 мл воды на килограмм массы тела.', reason: 'Общая рекомендация',
          });
        }
      } catch (e) {
        log.error(`не удалось сформировать рекомендации типа ${type}: ${e.message}`);
      }
    }
  }

  const GEN_SCHEMA = { recommendationTypes: { type: 'array', required: true, minItems: 1, items: TYPES } };
  function accept(ctx) {
    const userId = requireUser(ctx);
    const b = validate(ctx.body, GEN_SCHEMA);
    const requestId = randomUUID();
    setImmediate(() => runGeneration(userId, b.recommendationTypes));
    log.info('запрос на формирование рекомендаций принят', { requestId, types: b.recommendationTypes });
    return { status: 202, body: { requestId, status: 'accepted', acceptedAt: new Date().toISOString() } };
  }

  // --- публичный API ---
  app.get('/api/v1/recommendations', (ctx) => {
    const userId = requireUser(ctx);
    if (ctx.query.type && !TYPES.includes(ctx.query.type)) throw new ApiError(400, 'VALIDATION_ERROR', `type: допустимые значения ${TYPES.join(', ')}`);
    let list = [...recs.values()].filter((r) => r.userId === userId && (!ctx.query.type || r.type === ctx.query.type));
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { status: 200, body: paginate(list, ctx.query) };
  });
  app.post('/api/v1/recommendations/generate', accept, { idempotent: true });
  app.post('/internal/v1/recommendations/generate', accept, { idempotent: true });

  const own = (ctx) => {
    const r = recs.get(ctx.params.recommendationId);
    if (!r || r.userId !== requireUser(ctx)) throw new ApiError(404, 'RECOMMENDATION_NOT_FOUND', 'Запрашиваемая рекомендация не найдена');
    return r;
  };
  app.get('/api/v1/recommendations/:recommendationId', (ctx) => ({ status: 200, body: own(ctx) }));
  app.patch('/api/v1/recommendations/:recommendationId', (ctx) => {
    const r = own(ctx);
    const b = validate(ctx.body, { status: { type: 'string', required: true, enum: STATUSES } });
    r.status = b.status;
    r.updatedAt = new Date().toISOString();
    return { status: 200, body: r };
  }, { idempotent: true });

  // --- события ---
  registerConsumer(app, {
    brokerUrl: cfg.brokerUrl, selfUrl: cfg.selfUrl, queue: 'recommendation-service',
    handlers: {
      // nutrition -> recommendation
      DailyNutritionSummaryUpdated: async (p) => {
        const s = await goalFor(p.userId, p.date);
        const goal = s ? s.dailyCaloriesGoal : null;
        const found = evaluate({ summary: p, goal });
        log.info(`оценка сводки: сработало правил — ${found.length}`, { userId: p.userId, date: p.date });
        found.forEach((r) => upsert(p.userId, p.date, r));
      },
      // profile -> recommendation
      UserProfileUpdated: async (p) => { upsert(p.userId, 'static', activityTip(p)); },
    },
  });

  return app;
};
