'use strict';
const { createApp } = require('../shared/http');
const { ApiError } = require('../shared/problem');
const { isDate } = require('../shared/validate');
const { callService } = require('../shared/client');
const { createEvent, createOutbox, registerConsumer } = require('../shared/events');
const { paginate, requireUser, today } = require('../shared/util');
const { calcNorms, emptySummary, applyMacros, finalize } = require('./calc');

module.exports = function createNutritionService(cfg = {}) {
  const app = createApp({ name: 'nutrition-service', logLevel: cfg.logLevel });
  const log = app.log;
  const profileUrl = cfg.profileUrl || 'http://localhost:3001';
  const summaries = new Map();      // nutrition_db: `${userId}|${date}` -> сводка
  const contributions = new Map();  // entryId -> вклад записи в сводку (для Update/Delete)
  const outbox = createOutbox({ brokerUrl: cfg.brokerUrl, log, intervalMs: cfg.outboxIntervalMs });
  app.onClose(() => outbox.stop());
  app.summaries = summaries;

  const key = (userId, date) => `${userId}|${date}`;

  // синхронное взаимодействие №2: nutrition -> profile
  async function fetchProfile(userId) {
    const r = await callService({
      target: 'profile-service', baseUrl: profileUrl, caller: 'nutrition-service', log,
      path: `/internal/v1/profiles/${encodeURIComponent(userId)}`,
    });
    if (r.status === 404) throw new ApiError(404, 'DATA_NOT_FOUND', 'Профиль пользователя не найден — сначала заполните профиль');
    if (r.status !== 200) throw new ApiError(502, 'UPSTREAM_ERROR', 'Некорректный ответ profile-service');
    return r.body;
  }

  function publishUpdated(s) {
    outbox.add(createEvent('DailyNutritionSummaryUpdated', {
      userId: s.userId, date: s.date, consumedCalories: s.consumedCalories,
      consumedProtein: s.consumedProtein, consumedFat: s.consumedFat, consumedCarbohydrates: s.consumedCarbohydrates,
    }));
  }

  function getOrCreate(userId, date, goal) {
    let s = summaries.get(key(userId, date));
    if (!s) { s = emptySummary(userId, date, goal); summaries.set(key(userId, date), s); }
    if (goal != null) { s.dailyCaloriesGoal = goal; finalize(s); }
    return s;
  }

  // --- публичный API ---
  app.get('/api/v1/nutrition/norms', async (ctx) => {
    const profile = await fetchProfile(requireUser(ctx));
    return { status: 200, body: calcNorms(profile) };
  });

  app.get('/api/v1/nutrition/daily-summary', async (ctx) => {
    const userId = requireUser(ctx);
    if (!isDate(ctx.query.date)) throw new ApiError(400, 'VALIDATION_ERROR', 'Параметр date обязателен (YYYY-MM-DD)');
    let s = summaries.get(key(userId, ctx.query.date));
    if (!s) {
      let goal = null;
      try { goal = calcNorms(await fetchProfile(userId)).dailyCalories; } catch (_) { /* цель недоступна — вернём без неё */ }
      s = emptySummary(userId, ctx.query.date, goal);
    }
    return { status: 200, body: s };
  });

  app.get('/api/v1/nutrition/daily-summary/history', (ctx) => {
    const userId = requireUser(ctx);
    const { from, to } = ctx.query;
    if (!isDate(from) || !isDate(to)) throw new ApiError(400, 'VALIDATION_ERROR', 'Параметры from и to обязательны (YYYY-MM-DD)');
    if (from > to) throw new ApiError(400, 'VALIDATION_ERROR', 'from не может быть позже to');
    const list = [...summaries.values()].filter((s) => s.userId === userId && s.date >= from && s.date <= to)
      .sort((a, b) => a.date.localeCompare(b.date));
    return { status: 200, body: paginate(list, ctx.query) };
  });

  app.get('/internal/v1/nutrition/daily-summary', (ctx) => {
    const { userId, date } = ctx.query;
    if (!userId || !isDate(date)) throw new ApiError(400, 'VALIDATION_ERROR', 'userId и date обязательны');
    const s = summaries.get(key(userId, date));
    if (!s) throw new ApiError(404, 'DATA_NOT_FOUND', 'Данные о питании не найдены');
    return { status: 200, body: s };
  });

  // --- обработчики событий (асинхронное взаимодействие) ---
  const macrosOf = (p) => ({ calories: p.calories, protein: p.protein, fat: p.fat, carbohydrates: p.carbohydrates });

  registerConsumer(app, {
    brokerUrl: cfg.brokerUrl, selfUrl: cfg.selfUrl, queue: 'nutrition-service',
    handlers: {
      // diary -> nutrition
      MealEntryCreated: async (p) => {
        if (contributions.has(p.entryId)) { log.info('запись уже учтена в сводке', { entryId: p.entryId }); return; }
        // если profile-service недоступен — исключение -> 5xx -> брокер повторит доставку
        const goal = calcNorms(await fetchProfile(p.userId)).dailyCalories;
        const s = getOrCreate(p.userId, p.date, goal);
        applyMacros(s, macrosOf(p), 1);
        contributions.set(p.entryId, { userId: p.userId, date: p.date, ...macrosOf(p) });
        log.info(`сводка обновлена: ${p.userId} ${p.date} — ${s.consumedCalories} из ${s.dailyCaloriesGoal} ккал`);
        publishUpdated(s);
      },
      MealEntryUpdated: async (p) => {
        const old = contributions.get(p.entryId);
        if (old) applyMacros(summaries.get(key(old.userId, old.date)), old, -1);
        const s = getOrCreate(p.userId, p.date, null);
        applyMacros(s, macrosOf(p), 1);
        contributions.set(p.entryId, { userId: p.userId, date: p.date, ...macrosOf(p) });
        publishUpdated(s);
        if (old && (old.date !== p.date)) publishUpdated(summaries.get(key(old.userId, old.date)));
      },
      MealEntryDeleted: async (p) => {
        const old = contributions.get(p.entryId);
        if (!old) { log.warn('MealEntryDeleted: запись не учитывалась в сводке, игнорирую', { entryId: p.entryId }); return; }
        const s = summaries.get(key(old.userId, old.date));
        applyMacros(s, old, -1);
        contributions.delete(p.entryId);
        publishUpdated(s);
      },
      // profile -> nutrition: пересчёт цели на сегодня и далее
      UserProfileUpdated: async (p) => {
        const goal = calcNorms(p).dailyCalories;
        for (const s of summaries.values()) {
          if (s.userId === p.userId && s.date >= today()) {
            s.dailyCaloriesGoal = goal; finalize(s);
            log.info(`цель пересчитана после изменения профиля: ${goal} ккал`, { date: s.date });
            publishUpdated(s);
          }
        }
      },
    },
  });

  return app;
};
