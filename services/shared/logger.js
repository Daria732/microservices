'use strict';
/**
 * Логгер сервисов.
 * Используется winston (если установлен: `npm install`), иначе — console.
 * Формат строки одинаковый. В каждую строку автоматически добавляется
 * requestId и userId текущего запроса (AsyncLocalStorage), поэтому по одному
 * requestId можно проследить запрос через Gateway -> сервисы -> брокер.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

let winston = null;
try {
  winston = require('winston');
} catch (_) {
  winston = null;
}

function getContext() {
  return als.getStore() || {};
}

function runWithContext(store, fn) {
  return als.run(store, fn);
}

function formatLine(level, service, message, meta) {
  const ctx = getContext();
  const req = ctx.requestId ? ` [req=${String(ctx.requestId).slice(0, 8)}]` : '';
  const user = ctx.userId ? ` [user=${ctx.userId}]` : '';
  const m = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  return `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${service}]${req}${user} ${message}${m}`;
}

function createLogger(service, level = process.env.LOG_LEVEL || 'info') {
  const silent = level === 'silent';
  const effective = silent ? 'error' : level;
  let sink;

  if (winston) {
    const w = winston.createLogger({
      level: effective,
      silent,
      format: winston.format.printf((info) => info.message),
      transports: [new winston.transports.Console()],
    });
    sink = (lvl, line) => w.log(lvl, line);
  } else {
    const order = { error: 0, warn: 1, info: 2, debug: 3 };
    sink = (lvl, line) => {
      if (silent || order[lvl] > order[effective]) return;
      (lvl === 'error' ? console.error : console.log)(line);
    };
  }

  const make = (lvl) => (message, meta) => sink(lvl, formatLine(lvl, service, message, meta));
  return { error: make('error'), warn: make('warn'), info: make('info'), debug: make('debug') };
}

module.exports = { createLogger, runWithContext, getContext };
