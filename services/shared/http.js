'use strict';
/**
 * Минимальный HTTP-фреймворк на встроенном модуле node:http (без зависимостей):
 * маршрутизация, парсинг JSON, request-id, логирование каждого запроса,
 * единая обработка ошибок (RFC 7807), Idempotency-Key, режим имитации сбоя (chaos).
 */
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { createLogger, runWithContext } = require('./logger');
const { ApiError, toProblem } = require('./problem');
const { createIdempotencyStore, withIdempotency } = require('./idempotency');
const { sleep } = require('./util');

function compile(pattern) {
  const keys = [];
  const src = pattern.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp(`^${src}/?$`), keys };
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(400, 'PAYLOAD_TOO_LARGE', 'Слишком большое тело запроса')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, { status = 200, body, raw, headers = {} }) {
  const h = { ...headers };
  let payload = null;
  if (status !== 204 && (raw !== undefined || body !== undefined)) {
    payload = raw !== undefined ? raw : JSON.stringify(body);
    if (!Object.keys(h).some((k) => k.toLowerCase() === 'content-type')) {
      h['Content-Type'] = 'application/json; charset=utf-8';
    }
  }
  res.writeHead(status, h);
  res.end(payload);
}

function createApp({ name, logLevel, enableAdminChaos = true }) {
  const log = createLogger(name, logLevel);
  const routes = [];
  const idemStore = createIdempotencyStore();
  const closeHooks = [];
  const listenHooks = [];
  let fallbackHandler = null;

  const app = { name, log, chaos: { mode: 'ok', latencyMs: 0 }, port: null, baseUrl: null, server: null };

  app.route = (method, pattern, handler, opts = {}) => {
    routes.push({ method, ...compile(pattern), handler, opts });
  };
  for (const m of ['get', 'post', 'put', 'patch', 'delete']) {
    app[m] = (pattern, handler, opts) => app.route(m.toUpperCase(), pattern, handler, opts);
  }
  app.fallback = (h) => { fallbackHandler = h; };
  app.onClose = (fn) => closeHooks.push(fn);
  app.onListen = (fn) => listenHooks.push(fn);

  // Служебные эндпоинты (не входят в публичный контракт).
  // Для API Gateway встроенное управление chaos отключается: управление сервисами
  // должно идти только через защищённые /admin/services/:service/chaos маршруты Gateway.
  app.get('/health', () => ({ status: 200, body: { status: 'UP', service: name } }));
  if (enableAdminChaos) {
    app.get('/admin/chaos', () => ({ status: 200, body: { service: name, chaos: app.chaos } }));
    app.post('/admin/chaos', (ctx) => {
      const { mode, latencyMs } = ctx.body || {};
      if (!['ok', 'down'].includes(mode)) throw new ApiError(400, 'VALIDATION_ERROR', 'mode должен быть "ok" или "down"');
      app.chaos = { mode, latencyMs: Number(latencyMs) || 0 };
      log.warn(`CHAOS: режим имитации сбоя переключён в "${mode}"`, app.chaos);
      return { status: 200, body: { service: name, chaos: app.chaos } };
    });
  }

  async function dispatch(ctx) {
    const exempt = ctx.path === '/health' || ctx.path.startsWith('/admin/');
    if (!exempt) {
      if (app.chaos.latencyMs) await sleep(app.chaos.latencyMs);
      if (app.chaos.mode === 'down') {
        throw new ApiError(503, 'SERVICE_UNAVAILABLE', `Сервис ${name} временно недоступен (имитация сбоя)`);
      }
    }
    let matched = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(ctx.path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== ctx.method) continue;
      matched = { r, m };
      break;
    }
    if (!matched) {
      if (fallbackHandler) return fallbackHandler(ctx);
      if (pathMatched) throw new ApiError(405, 'METHOD_NOT_ALLOWED', `Метод ${ctx.method} не поддерживается для ${ctx.path}`);
      throw new ApiError(404, 'NOT_FOUND', `Маршрут ${ctx.method} ${ctx.path} не найден`);
    }
    matched.r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(matched.m[i + 1]); });
    if (ctx.rawBody) {
      try { ctx.body = JSON.parse(ctx.rawBody); } catch (_) {
        throw new ApiError(400, 'INVALID_JSON', 'Тело запроса не является корректным JSON');
      }
    }
    const exec = () => matched.r.handler(ctx);
    return matched.r.opts.idempotent ? withIdempotency(idemStore, ctx, exec) : exec();
  }

  async function handle(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://localhost');
    const requestId = req.headers['x-request-id'] || randomUUID();
    const store = { requestId, userId: req.headers['x-user-id'] };

    await runWithContext(store, async () => {
      const ctx = {
        method: req.method, path: url.pathname, search: url.search,
        query: Object.fromEntries(url.searchParams), headers: req.headers,
        params: {}, body: undefined, rawBody: '', requestId, log,
        get userId() { return store.userId; },
      };
      let result;
      try {
        ctx.rawBody = await readBody(req);
        let bodyMeta;
        if (ctx.rawBody && ctx.method !== 'GET') bodyMeta = ctx.rawBody.length > 400 ? `${ctx.rawBody.slice(0, 400)}…` : ctx.rawBody;
        log.info(`→ запрос получен: ${ctx.method} ${ctx.path}${ctx.search}`, {
          idempotencyKey: req.headers['idempotency-key'],
          caller: req.headers['x-internal-caller'],
          body: bodyMeta,
        });
        result = (await dispatch(ctx)) || { status: 204 };
      } catch (err) {
        if (err instanceof ApiError) {
          result = {
            status: err.status, body: toProblem(err, ctx.path),
            headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
          };
        } else {
          log.error(`необработанная ошибка: ${err.stack || err.message}`);
          result = {
            status: 500,
            body: toProblem(new ApiError(500, 'INTERNAL_ERROR', 'Произошла внутренняя ошибка сервера'), ctx.path),
            headers: { 'Content-Type': 'application/problem+json; charset=utf-8' },
          };
        }
      }
      result.headers = { 'X-Request-Id': requestId, ...(result.headers || {}) };
      send(res, result);
      const lvl = result.status >= 500 ? 'error' : result.status >= 400 ? 'warn' : 'info';
      const extra = result.body && result.body.code ? ` code=${result.body.code}` : '';
      log[lvl](`← ответ ${result.status} на ${ctx.method} ${ctx.path} (${Date.now() - started} мс)${extra}`);
    });
  }

  app.listen = (port = 0) => new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        log.error(`fatal: ${e.message}`);
        try { res.writeHead(500); res.end(); } catch (_) { /* ignore */ }
      });
    });
    server.on('error', reject);
    server.listen(port, async () => {
      app.server = server;
      app.port = server.address().port;
      app.baseUrl = `http://localhost:${app.port}`;
      log.info(`сервис запущен, порт ${app.port}`);
      for (const h of listenHooks) await h(app);
      resolve(app);
    });
  });

  app.close = async () => {
    for (const h of closeHooks) await h();
    if (!app.server) return;
    await new Promise((r) => {
      app.server.close(() => r());
      if (app.server.closeAllConnections) app.server.closeAllConnections();
    });
  };

  return app;
}

module.exports = { createApp };
