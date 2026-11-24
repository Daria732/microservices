'use strict';
const { createApp } = require('../shared/http');
const { ApiError } = require('../shared/problem');
const { validate } = require('../shared/validate');
const { createEvent, createOutbox } = require('../shared/events');

const ACTIVITY = ['low', 'moderate', 'high', 'very_high'];
const GOALS = ['weight_loss', 'maintenance', 'weight_gain'];
const GENDERS = ['female', 'male'];

const CREATE_SCHEMA = {
  userId: { type: 'string', required: true },
  age: { type: 'integer', required: true, min: 14, max: 100 },
  gender: { type: 'string', required: true, enum: GENDERS },
  height: { type: 'number', required: true, min: 50, max: 250 },
  weight: { type: 'number', required: true, min: 20, max: 400 },
  activityLevel: { type: 'string', required: true, enum: ACTIVITY },
  goal: { type: 'string', required: true, enum: GOALS },
};
const UPDATE_SCHEMA = {
  age: { type: 'integer', min: 14, max: 100 },
  gender: { type: 'string', enum: GENDERS },
  height: { type: 'number', min: 50, max: 250 },
  weight: { type: 'number', min: 20, max: 400 },
  activityLevel: { type: 'string', enum: ACTIVITY },
  goal: { type: 'string', enum: GOALS },
  preferences: { type: 'array' },
  excludedProducts: { type: 'array' },
};

module.exports = function createProfileService(cfg = {}) {
  const app = createApp({ name: 'profile-service', logLevel: cfg.logLevel });
  const log = app.log;
  const profiles = new Map(); // собственное хранилище profile_db (in-memory)
  const outbox = createOutbox({ brokerUrl: cfg.brokerUrl, log, intervalMs: cfg.outboxIntervalMs });
  app.onClose(() => outbox.stop());
  app.profiles = profiles;
  app.outbox = outbox;

  function assertOwner(ctx, userId) {
    if (ctx.userId && ctx.userId !== userId) {
      throw new ApiError(403, 'FORBIDDEN', 'Нельзя работать с чужим профилем');
    }
  }
  function getOr404(userId) {
    const p = profiles.get(userId);
    if (!p) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Профиль пользователя не найден');
    return p;
  }

  app.post('/api/v1/profiles', (ctx) => {
    const b = validate(ctx.body, CREATE_SCHEMA);
    assertOwner(ctx, b.userId);
    if (profiles.has(b.userId)) throw new ApiError(409, 'PROFILE_ALREADY_EXISTS', 'Профиль пользователя уже существует');
    const profile = {
      userId: b.userId, age: b.age, gender: b.gender, height: b.height, weight: b.weight,
      activityLevel: b.activityLevel, goal: b.goal, preferences: [], excludedProducts: [],
      updatedAt: new Date().toISOString(),
    };
    profiles.set(profile.userId, profile);
    log.info('профиль создан', { userId: profile.userId, goal: profile.goal });
    return { status: 201, body: profile };
  }, { idempotent: true });

  app.get('/api/v1/profiles/:userId', (ctx) => {
    assertOwner(ctx, ctx.params.userId);
    return { status: 200, body: getOr404(ctx.params.userId) };
  });

  app.put('/api/v1/profiles/:userId', (ctx) => {
    assertOwner(ctx, ctx.params.userId);
    const p = getOr404(ctx.params.userId);
    const b = validate(ctx.body, UPDATE_SCHEMA, { partial: true });
    const fields = Object.keys(UPDATE_SCHEMA).filter((k) => b[k] !== undefined);
    if (!fields.length) throw new ApiError(400, 'VALIDATION_ERROR', 'Не передано ни одного поля для обновления');
    for (const k of fields) p[k] = b[k];
    p.updatedAt = new Date().toISOString();
    log.info('профиль обновлён', { userId: p.userId, fields });
    outbox.add(createEvent('UserProfileUpdated', {
      userId: p.userId, age: p.age, gender: p.gender, height: p.height,
      weight: p.weight, activityLevel: p.activityLevel, goal: p.goal,
    }));
    return { status: 200, body: p };
  }, { idempotent: true });

  // внутренний эндпоинт (недоступен через Gateway)
  app.get('/internal/v1/profiles/:userId', (ctx) => ({ status: 200, body: getOr404(ctx.params.userId) }));

  return app;
};
