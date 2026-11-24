'use strict';
const { ApiError } = require('./problem');
const { getContext } = require('./logger');

/**
 * Синхронный вызов другого сервиса. Пробрасывает X-Request-Id.
 * Возвращает { status, body } для любых ответов < 500.
 * Сетевая ошибка, таймаут или 5xx -> ApiError 503 SERVICE_UNAVAILABLE.
 */
async function callService({ target, baseUrl, method = 'GET', path, body, headers = {}, timeoutMs = 2000, log, caller }) {
  const h = { 'Content-Type': 'application/json', 'X-Internal-Caller': caller, ...headers };
  const ctx = getContext();
  if (ctx.requestId) h['X-Request-Id'] = ctx.requestId;

  log.info(`SYNC → вызываю ${target}: ${method} ${path}`);
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method, headers: h,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e.name === 'TimeoutError' ? 'таймаут' : (e.cause && e.cause.code) || e.message;
    log.error(`SYNC ✗ ${target} недоступен: ${why}`);
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', `Сервис ${target} недоступен`, { service: target });
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : undefined; } catch (_) { data = text; }
  log.info(`SYNC ← ответ от ${target}: ${res.status}`);
  if (res.status >= 500) {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', `Сервис ${target} временно недоступен`, { service: target, upstreamStatus: res.status });
  }
  return { status: res.status, body: data };
}

module.exports = { callService };
