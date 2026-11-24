'use strict';
const { ApiError } = require('./problem');

const round1 = (n) => Math.round(n * 10) / 10;
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireUser(ctx) {
  if (!ctx.userId) throw new ApiError(401, 'UNAUTHORIZED', 'Не передан идентификатор пользователя (X-User-Id). Обращайтесь через API Gateway');
  return ctx.userId;
}

function pageParams(q) {
  const page = q.page === undefined ? 1 : Number(q.page);
  const pageSize = q.pageSize === undefined ? 20 : Number(q.pageSize);
  if (!Number.isInteger(page) || page < 1) throw new ApiError(400, 'VALIDATION_ERROR', 'page должен быть целым числом >= 1');
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'pageSize должен быть целым числом от 1 до 100');
  }
  return { page, pageSize };
}

function paginate(all, q) {
  const { page, pageSize } = pageParams(q);
  const start = (page - 1) * pageSize;
  return { items: all.slice(start, start + pageSize), page, pageSize, total: all.length };
}

module.exports = { round1, today, sleep, requireUser, pageParams, paginate };
