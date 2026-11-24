'use strict';
const { createApp } = require('../shared/http');
const { ApiError } = require('../shared/problem');
const { getContext } = require('../shared/logger');

/**
 * Минимальный API Gateway.
 * Публичные и административные запросы проходят через Gateway.
 * Внутренние /internal/* маршруты клиентам недоступны.
 * Административные маршруты доступны только с мок-токеном mock-jwt-admin.
 */
module.exports = function createGateway(cfg = {}) {
  const app = createApp({ name: 'api-gateway', logLevel: cfg.logLevel, enableAdminChaos: false });
  const log = app.log;

  const services = {
    profile: { name: 'profile-service', url: cfg.profileUrl },
    food: { name: 'food-service', url: cfg.foodUrl },
    diary: { name: 'diary-service', url: cfg.diaryUrl },
    nutrition: { name: 'nutrition-service', url: cfg.nutritionUrl },
    recommendation: { name: 'recommendation-service', url: cfg.recommendationUrl },
  };

  const routes = [
    { prefix: '/api/v1/profiles', name: 'profile-service', url: cfg.profileUrl },
    { prefix: '/api/v1/products', name: 'food-service', url: cfg.foodUrl },
    { prefix: '/api/v1/pantry', name: 'food-service', url: cfg.foodUrl },
    { prefix: '/api/v1/diary', name: 'diary-service', url: cfg.diaryUrl },
    { prefix: '/api/v1/nutrition', name: 'nutrition-service', url: cfg.nutritionUrl },
    { prefix: '/api/v1/recommendations', name: 'recommendation-service', url: cfg.recommendationUrl },
    { prefix: '/api/v1/activities', name: 'activity-service', url: null },
    { prefix: '/api/v1/recipes', name: 'recipe-service', url: null },
  ];

  async function proxy(ctx, targetUrl, targetPath, targetName) {
    if (!targetUrl) throw new ApiError(503, 'SERVICE_UNAVAILABLE', `Адрес ${targetName} не настроен`);
    const headers = { 'X-Request-Id': ctx.requestId, 'X-Forwarded-By': 'api-gateway' };
    if (ctx.userId && ctx.userId !== 'admin') headers['X-User-Id'] = ctx.userId;
    for (const h of ['content-type', 'idempotency-key']) if (ctx.headers[h]) headers[h] = ctx.headers[h];
    const hasBody = !['GET', 'HEAD'].includes(ctx.method);
    let res;
    try {
      res = await fetch(targetUrl + targetPath, {
        method: ctx.method, headers,
        body: hasBody && ctx.rawBody ? ctx.rawBody : undefined,
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      log.error(`GATEWAY: ${targetName} недоступен: ${e.message}`);
      throw new ApiError(503, 'SERVICE_UNAVAILABLE', `Сервис ${targetName} недоступен`);
    }
    const body = await res.text();
    log.info(`GATEWAY: ${targetName} ответил ${res.status}`, { path: targetPath });
    const out = {};
    for (const h of ['content-type', 'idempotent-replayed']) if (res.headers.get(h)) out[h] = res.headers.get(h);
    return { status: res.status, raw: body, headers: out };
  }

  async function handleAdmin(ctx) {
    const m = /^Bearer mock-jwt-([A-Za-z0-9_-]+)$/.exec(ctx.headers.authorization || '');
    if (!m) throw new ApiError(401, 'UNAUTHORIZED', 'Для административных маршрутов требуется токен администратора');
    if (m[1] !== 'admin') throw new ApiError(403, 'FORBIDDEN', 'Недостаточно прав для административного маршрута');
    getContext().userId = 'admin';

    let match = /^\/admin\/services\/(profile|food|diary|nutrition|recommendation)\/chaos$/.exec(ctx.path);
    if (match) {
      if (!['GET', 'POST'].includes(ctx.method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Поддерживаются GET и POST');
      const service = services[match[1]];
      log.info(`ADMIN: ${ctx.method} chaos → ${service.name}`);
      return proxy(ctx, service.url, '/admin/chaos', service.name);
    }
    if (ctx.path === '/admin/diary/compensations' && ctx.method === 'GET') {
      log.info('ADMIN: просмотр журнала компенсаций');
      return proxy(ctx, services.diary.url, '/admin/compensations', 'diary-service');
    }
    if (ctx.path === '/admin/broker/queues' && ctx.method === 'GET') {
      log.info('ADMIN: просмотр очередей брокера');
      return proxy(ctx, cfg.brokerUrl, '/queues', 'message-broker');
    }
    if (ctx.path === '/admin/broker/dlq' && ctx.method === 'GET') {
      log.info('ADMIN: просмотр Dead Letter Queue');
      return proxy(ctx, cfg.brokerUrl, '/dlq', 'message-broker');
    }
    match = /^\/admin\/broker\/dlq\/([^/]+)\/replay$/.exec(ctx.path);
    if (match && ctx.method === 'POST') {
      log.info('ADMIN: повторная доставка сообщения из DLQ');
      return proxy(ctx, cfg.brokerUrl, `/dlq/${encodeURIComponent(decodeURIComponent(match[1]))}/replay`, 'message-broker');
    }
    throw new ApiError(404, 'NOT_FOUND', `Административный маршрут ${ctx.method} ${ctx.path} не найден`);
  }

  app.fallback(async (ctx) => {
    if (ctx.path.startsWith('/internal/')) {
      log.warn('GATEWAY: попытка обратиться к внутреннему маршруту — отклонено', { path: ctx.path });
      throw new ApiError(404, 'NOT_FOUND', 'Маршрут не найден');
    }
    if (ctx.path === '/admin' || ctx.path.startsWith('/admin/')) return handleAdmin(ctx);

    const route = routes.find((r) => ctx.path === r.prefix || ctx.path.startsWith(`${r.prefix}/`));
    if (!route) throw new ApiError(404, 'NOT_FOUND', `Маршрут ${ctx.method} ${ctx.path} не найден`);
    const m = /^Bearer mock-jwt-([A-Za-z0-9_-]+)$/.exec(ctx.headers.authorization || '');
    if (!m || m[1] === 'admin') throw new ApiError(401, 'UNAUTHORIZED', 'Требуется пользовательский токен Authorization: Bearer mock-jwt-<userId>');
    const userId = m[1];
    getContext().userId = userId;
    log.info(`GATEWAY: токен проверен (мок Keycloak), userId=${userId}; маршрут → ${route.name}`);
    if (!route.url) throw new ApiError(501, 'NOT_IMPLEMENTED', `${route.name} спроектирован, но не реализован в лабораторной работе №4`);
    return proxy(ctx, route.url, ctx.path + ctx.search, route.name);
  });
  return app;
};
