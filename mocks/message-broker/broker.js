'use strict';
/**
 * МОК RabbitMQ (in-memory брокер с HTTP-интерфейсом).
 * Повторяет поведение, описанное в диаграммах лабораторной №3:
 *   publish -> очередь подписчика -> доставка (HTTP POST callback)
 *   2xx = ack; иначе -> Retry Queue (повтор через RETRY_DELAY_MS);
 *   после MAX_ATTEMPTS неудач -> Dead Letter Queue + событие "<Тип>.DeadLettered"
 *   (оно используется для компенсирующих действий саги).
 */
const { randomUUID } = require('node:crypto');
const { createApp } = require('../../services/shared/http');
const { ApiError } = require('../../services/shared/problem');
const { validate } = require('../../services/shared/validate');
const { createEvent } = require('../../services/shared/events');
const { runWithContext } = require('../../services/shared/logger');

module.exports = function createBroker(cfg = {}) {
  const retryDelayMs = cfg.retryDelayMs ?? 3000;
  const maxAttempts = cfg.maxAttempts ?? 5;
  const deliveryTimeoutMs = cfg.deliveryTimeoutMs ?? 3000;

  const app = createApp({ name: 'message-broker', logLevel: cfg.logLevel });
  const log = app.log;
  const queues = new Map();
  const dlq = [];
  const timers = new Set();
  let closed = false;
  app.onClose(() => { closed = true; for (const t of timers) clearTimeout(t); });
  app.dlq = dlq;
  app.queues = queues;

  async function deliver(q, msg) {
    if (closed) return;
    msg.attempts += 1;
    const t = msg.event.eventType;
    log.info(`DELIVER → ${q.name}: ${t} (попытка ${msg.attempts}/${maxAttempts})`, { eventId: msg.event.eventId });
    try {
      const res = await fetch(q.callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delivery-Attempt': String(msg.attempts), 'X-Queue': q.name, 'X-Request-Id': msg.requestId },
        body: JSON.stringify(msg.event), signal: AbortSignal.timeout(deliveryTimeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      q.stats.delivered += 1;
      log.info(`ACK ✓ ${q.name} подтвердил ${t}`, { eventId: msg.event.eventId, attempts: msg.attempts });
    } catch (e) {
      const why = e.name === 'TimeoutError' ? 'таймаут' : e.message;
      if (msg.attempts >= maxAttempts) {
        q.stats.deadLettered += 1;
        const entry = { id: msg.id, queue: q.name, event: msg.event, attempts: msg.attempts, lastError: why, deadLetteredAt: new Date().toISOString() };
        dlq.push(entry);
        log.error(`DEAD-LETTER ✗ ${t} для ${q.name}: исчерпаны попытки (${msg.attempts}), причина: ${why}`, { eventId: msg.event.eventId });
        if (!t.endsWith('.DeadLettered')) {
          publish(createEvent(`${t}.DeadLettered`, { queue: q.name, attempts: msg.attempts, lastError: why, event: msg.event }), msg.requestId);
        }
        return;
      }
      q.stats.retried += 1;
      log.warn(`NACK ✗ ${q.name} не обработал ${t} (${why}) — перемещаю в Retry Queue, повтор через ${retryDelayMs} мс`, { eventId: msg.event.eventId });
      const timer = setTimeout(() => {
        timers.delete(timer);
        runWithContext({ requestId: msg.requestId }, () => deliver(q, msg));
      }, retryDelayMs);
      timers.add(timer);
    }
  }

  function publish(event, requestId) {
    const targets = [...queues.values()].filter((q) => q.eventTypes.has(event.eventType));
    if (!targets.length) {
      log.warn(`PUBLISH: для ${event.eventType} нет подписанных очередей — событие отброшено`, { eventId: event.eventId });
      return 0;
    }
    for (const q of targets) {
      log.info(`ROUTE: ${event.eventType} → очередь ${q.name}`, { eventId: event.eventId });
      runWithContext({ requestId }, () => deliver(q, { id: randomUUID(), event, attempts: 0, requestId }));
    }
    return targets.length;
  }

  app.post('/subscriptions', (ctx) => {
    const b = validate(ctx.body, {
      queue: { type: 'string', required: true },
      eventTypes: { type: 'array', required: true, minItems: 1 },
      callbackUrl: { type: 'string', required: true },
    });
    const prev = queues.get(b.queue);
    queues.set(b.queue, {
      name: b.queue, eventTypes: new Set(b.eventTypes), callbackUrl: b.callbackUrl,
      stats: prev ? prev.stats : { delivered: 0, retried: 0, deadLettered: 0 },
    });
    log.info(`SUBSCRIBE: очередь ${b.queue} → ${b.callbackUrl}`, { eventTypes: b.eventTypes });
    return { status: 201, body: { queue: b.queue, eventTypes: b.eventTypes } };
  });

  app.post('/publish', (ctx) => {
    const ev = ctx.body;
    if (!ev || !ev.eventId || !ev.eventType || !ev.payload) throw new ApiError(400, 'VALIDATION_ERROR', 'Событие должно содержать eventId, eventType, payload');
    log.info(`PUBLISH ← событие ${ev.eventType}`, { eventId: ev.eventId });
    const routed = publish(ev, ctx.requestId);
    return { status: 202, body: { accepted: true, routedTo: routed } };
  });

  app.get('/queues', () => ({
    status: 200,
    body: { items: [...queues.values()].map((q) => ({ queue: q.name, eventTypes: [...q.eventTypes], callbackUrl: q.callbackUrl, ...q.stats })), deadLetterCount: dlq.length },
  }));
  app.get('/dlq', () => ({ status: 200, body: { items: dlq, total: dlq.length } }));
  app.post('/dlq/:id/replay', (ctx) => {
    const i = dlq.findIndex((d) => d.id === ctx.params.id);
    if (i < 0) throw new ApiError(404, 'NOT_FOUND', 'Сообщение в DLQ не найдено');
    const [d] = dlq.splice(i, 1);
    const q = queues.get(d.queue);
    if (!q) throw new ApiError(409, 'QUEUE_NOT_FOUND', 'Очередь не найдена');
    log.info(`REPLAY: повторная доставка ${d.event.eventType} в ${d.queue}`);
    deliver(q, { id: d.id, event: d.event, attempts: 0, requestId: ctx.requestId });
    return { status: 202, body: { replayed: d.id } };
  });

  return app;
};
