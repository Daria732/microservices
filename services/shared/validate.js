'use strict';
const { ApiError } = require('./problem');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(v) {
  if (typeof v !== 'string' || !DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** schema: { field: { type, required, enum, min, max, minItems, items, nullable } } */
function validate(body, schema, { partial = false } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Тело запроса должно быть JSON-объектом');
  }
  const errors = [];
  for (const [field, rule] of Object.entries(schema)) {
    const v = body[field];
    if (v === undefined || (v === null && rule.nullable)) {
      if (rule.required && !partial) errors.push({ field, message: 'обязательное поле' });
      continue;
    }
    const bad = (message) => errors.push({ field, message });
    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string' || v.trim() === '') bad('должно быть непустой строкой');
        break;
      case 'integer':
        if (!Number.isInteger(v)) bad('должно быть целым числом');
        break;
      case 'number':
        if (typeof v !== 'number' || !Number.isFinite(v)) bad('должно быть числом');
        break;
      case 'date':
        if (!isDate(v)) bad('должна быть датой в формате YYYY-MM-DD');
        break;
      case 'array':
        if (!Array.isArray(v)) bad('должно быть массивом');
        else {
          if (rule.minItems && v.length < rule.minItems) bad(`минимум элементов: ${rule.minItems}`);
          if (rule.items && v.some((x) => !rule.items.includes(x))) {
            bad(`допустимые значения элементов: ${rule.items.join(', ')}`);
          }
        }
        break;
      default:
        break;
    }
    if (rule.enum && !rule.enum.includes(v)) bad(`допустимые значения: ${rule.enum.join(', ')}`);
    if (typeof v === 'number') {
      if (rule.min !== undefined && v < rule.min) bad(`минимум ${rule.min}`);
      if (rule.max !== undefined && v > rule.max) bad(`максимум ${rule.max}`);
    }
  }
  if (errors.length) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Проверьте корректность переданных данных', { errors });
  }
  return body;
}

module.exports = { validate, isDate };
