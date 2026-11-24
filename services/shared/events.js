'use strict';
const { randomUUID } = require('node:crypto');
const { getContext } = require('./logger');
const { ApiError } = require('./problem');

/** Формат события — как в OpenAPI (eventId, eventType, occurredAt, schemaVersion, payload). */
function createEvent(eventType, payload) {
  return { eventId: randomUUID(), eventType, occurredAt: new Date().toISOString(), schemaVersion: '1.0', payload };
}

async function publishEvent(brokerUrl, event, timeoutMs = 2000) {
  const headers = { 'Content-Type': 'application/json' };
  const ctx = getContext();
  if (ctx.requestId) headers['X-Request-Id'] = ctx.requestId;
  const res = await fetch(`${brokerUrl}/publish`, {
    method: 'POST', headers, body: JSON.stringify(event), signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`брокер ответил ${res.status}`);
}

/**
 * Transactional Outbox: событие сначала сохраняется (в «транзакции» сервиса),
 * затем публикуется. Если брокер недоступен — событие остаётся в outbox
 * и отправляется повторно по таймеру.
 */
function createOutbox({ brokerUrl, log, intervalMs = 2000 }) {
  const items = [];
  let flushing = false;

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      for (const it of items) {
        if (it.published) continue;
        try {
          await publishEvent(brokerUrl, it.event);
          it.published = true;
          log.info(`OUTBOX → событие ${it.event.eventType} опубликовано в брокер`, { eventId: it.event.eventId });
        } catch (e) {
          log.warn(`OUTBOX: брокер недоступен (${e.message}), событие ${it.event.eventType} остаётся в outbox`, { eventId: it.event.eventId });
          break;
        }
      }
      for (let i = items.length - 1; i >= 0; i--) if (items[i].published) items.splice(i, 1);
    } finally {
      flushing = false;
    }
  }

  const timer = setInterval(flush, intervalMs);
  timer.unref();

  return {
    add(event) {
      items.push({ event, published: false });
      log.info(`OUTBOX: событие ${event.eventType} сохранено`, { eventId: event.eventId });
      flush();
    },
    flush,
    pending: () => items.filter((i) => !i.published).length,
    stop: () => clearInterval(timer),
  };
}

/**
 * Потребитель событий: HTTP-эндпоинт POST /internal/events (его вызывает брокер)
 * + подписка в брокере. Ответ 2xx = ack, иначе брокер повторит доставку.
 * Дедупликация по eventId (доставка at-least-once).
 */
function registerConsumer(app, { brokerUrl, queue, handlers, selfUrl }) {
  const processed = new Set();
  const log = app.log;

  app.post('/internal/events', async (ctx) => {
    const ev = ctx.body;
    if (!ev || !ev.eventId || !ev.eventType) throw new ApiError(400, 'VALIDATION_ERROR', 'Некорректный формат события');
    log.info(`EVENT ← получено событие ${ev.eventType}`, { eventId: ev.eventId, queue, attempt: ctx.headers['x-delivery-attempt'] });
    if (processed.has(ev.eventId)) {
      log.info(`EVENT: ${ev.eventType} уже обработано ранее (дубликат), пропускаю`, { eventId: ev.eventId });
      return { status: 200, body: { status: 'duplicate' } };
    }
    const handler = handlers[ev.eventType];
    if (!handler) return { status: 200, body: { status: 'ignored' } };
    await handler(ev.payload, ev);
    processed.add(ev.eventId);
    log.info(`EVENT ✓ ${ev.eventType} обработано, подтверждаю (ack)`, { eventId: ev.eventId });
    return { status: 200, body: { status: 'processed' } };
  });

  let stopped = false;
  let timer;
  app.onClose(() => { stopped = true; clearTimeout(timer); });
  app.onListen(() => {
    const attempt = async () => {
      try {
        const res = await fetch(`${brokerUrl}/subscriptions`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ queue, eventTypes: Object.keys(handlers), callbackUrl: `${selfUrl || app.baseUrl}/internal/events` }),
          signal: AbortSignal.timeout(2000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        log.info(`подписка в брокере оформлена: очередь "${queue}"`, { events: Object.keys(handlers) });
      } catch (e) {
        log.warn(`брокер недоступен (${e.message}), повторю подписку через 2 с`);
        if (!stopped) { timer = setTimeout(attempt, 2000); timer.unref(); }
      }
    };
    attempt();
  });
}

module.exports = { createEvent, publishEvent, createOutbox, registerConsumer };
