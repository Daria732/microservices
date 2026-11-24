'use strict';
const { createHash } = require('node:crypto');
const { ApiError } = require('./problem');

function createIdempotencyStore() {
  return new Map();
}

/**
 * Идемпотентность по заголовку Idempotency-Key.
 *  - ключ обязателен (как в контрактах);
 *  - повтор с тем же ключом и тем же телом -> возвращается сохранённый ответ
 *    (заголовок Idempotent-Replayed: true), операция НЕ выполняется повторно;
 *  - тот же ключ с другим телом -> 422 IDEMPOTENCY_KEY_REUSED;
 *  - параллельные запросы с одним ключом ждут результат первого;
 *  - ошибки не запоминаются (клиент может повторить запрос).
 */
async function withIdempotency(store, ctx, exec) {
  const key = ctx.headers['idempotency-key'];
  if (!key || !String(key).trim()) {
    throw new ApiError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Заголовок Idempotency-Key обязателен для этой операции');
  }
  const scope = [ctx.userId || '-', ctx.method, ctx.path, key].join('|');
  const fingerprint = createHash('sha256').update(ctx.rawBody || '').digest('hex');

  const existing = store.get(scope);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key уже использован с другим телом запроса');
    }
    const saved = await existing.promise;
    ctx.log.info('IDEMPOTENCY: повторный запрос с тем же ключом — возвращаю сохранённый ответ, операция не выполняется', { key });
    return { ...saved, headers: { ...(saved.headers || {}), 'Idempotent-Replayed': 'true' } };
  }

  const promise = Promise.resolve().then(exec);
  store.set(scope, { fingerprint, promise });
  try {
    const result = await promise;
    if (result && result.status >= 500) store.delete(scope);
    return result;
  } catch (err) {
    store.delete(scope);
    throw err;
  }
}

module.exports = { createIdempotencyStore, withIdempotency };
