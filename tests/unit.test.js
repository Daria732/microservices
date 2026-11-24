'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcNorms, applyMacros, emptySummary } = require('../services/nutrition-service/calc');
const { calcMacros } = require('../services/diary-service/calc');
const { evaluate, activityTip } = require('../services/recommendation-service/rules');
const { validate } = require('../services/shared/validate');
const { createIdempotencyStore, withIdempotency } = require('../services/shared/idempotency');
const { ApiError, toProblem } = require('../services/shared/problem');

test('nutrition: расчёт норм по Mifflin-St Jeor (женщина, 21, 173 см, 60 кг, низкая активность, похудение)', () => {
  const n = calcNorms({ userId: 'u', age: 21, gender: 'female', height: 173, weight: 60, activityLevel: 'low', goal: 'weight_loss' });
  assert.equal(n.dailyCalories, 1444); // (600+1081.25-105-161)*1.2*0.85
  assert.equal(n.protein, 96);
  assert.equal(n.fat, 40);
  assert.equal(n.carbohydrates, 175);
});

test('nutrition: цель «набор массы» даёт больше калорий, чем «поддержание»', () => {
  const base = { userId: 'u', age: 30, gender: 'male', height: 180, weight: 80, activityLevel: 'moderate' };
  assert.ok(calcNorms({ ...base, goal: 'weight_gain' }).dailyCalories > calcNorms({ ...base, goal: 'maintenance' }).dailyCalories);
});

test('nutrition: сводка суммирует и вычитает КБЖУ, остаток считается от цели, не уходит ниже нуля', () => {
  const s = emptySummary('u', '2026-11-24', 2000);
  applyMacros(s, { calories: 500, protein: 20, fat: 10, carbohydrates: 60 }, 1);
  applyMacros(s, { calories: 300, protein: 10, fat: 5, carbohydrates: 40 }, 1);
  assert.equal(s.consumedCalories, 800);
  assert.equal(s.remainingCalories, 1200);
  applyMacros(s, { calories: 500, protein: 20, fat: 10, carbohydrates: 60 }, -1);
  assert.equal(s.consumedCalories, 300);
  applyMacros(s, { calories: 9999, protein: 0, fat: 0, carbohydrates: 0 }, -1);
  assert.equal(s.consumedCalories, 0);
});

test('diary: КБЖУ порции пересчитывается от значений на 100 г', () => {
  const m = calcMacros({ calories: 370, protein: 13.2, fat: 6.5, carbohydrates: 62 }, 150);
  assert.deepEqual(m, { calories: 555, protein: 19.8, fat: 9.8, carbohydrates: 93 });
});

test('recommendation: правила — мало белка, превышение калорий, в норме', () => {
  const low = evaluate({ summary: { consumedCalories: 370, consumedProtein: 13.2 }, goal: 1444 });
  assert.ok(low.some((r) => r.key === 'low_protein' && r.title === 'Увеличьте потребление белка'));
  const excess = evaluate({ summary: { consumedCalories: 2000, consumedProtein: 150 }, goal: 1500 });
  assert.ok(excess.some((r) => r.key === 'calorie_excess'));
  const ok = evaluate({ summary: { consumedCalories: 1000, consumedProtein: 80 }, goal: 1500 });
  assert.deepEqual(ok.map((r) => r.key), ['on_track']);
  assert.equal(evaluate({ summary: { consumedCalories: 100, consumedProtein: 0 }, goal: null }).length, 0);
  assert.equal(activityTip({ goal: 'weight_loss' }).type, 'activity');
});

test('validate: собирает все ошибки, проверяет enum, диапазоны и даты', () => {
  const schema = { age: { type: 'integer', required: true, min: 14 }, goal: { type: 'string', enum: ['a', 'b'] }, date: { type: 'date' } };
  assert.throws(() => validate({ age: 5, goal: 'x', date: '2026-02-31' }, schema), (e) => {
    assert.equal(e.status, 400);
    assert.equal(e.code, 'VALIDATION_ERROR');
    assert.equal(e.details.errors.length, 3);
    return true;
  });
  assert.throws(() => validate({}, schema), (e) => e.details.errors[0].field === 'age');
  assert.doesNotThrow(() => validate({}, schema, { partial: true }));
});

test('problem details: формат RFC 7807 + поля контракта code/message', () => {
  const p = toProblem(new ApiError(404, 'ENTRY_NOT_FOUND', 'нет записи'), '/x');
  assert.equal(p.status, 404);
  assert.equal(p.title, 'Not Found');
  assert.equal(p.detail, 'нет записи');
  assert.equal(p.instance, '/x');
  assert.equal(p.code, 'ENTRY_NOT_FOUND');
  assert.equal(p.message, 'нет записи');
});

test('idempotency: повтор не выполняет операцию заново; другое тело -> 422; ключ обязателен', async () => {
  const store = createIdempotencyStore();
  const mk = (body, key) => ({ headers: key ? { 'idempotency-key': key } : {}, userId: 'u', method: 'POST', path: '/p', rawBody: body, log: { info() {} } });
  let calls = 0;
  const exec = async () => { calls += 1; return { status: 201, body: { n: calls } }; };

  const a = await withIdempotency(store, mk('{"a":1}', 'k1'), exec);
  const b = await withIdempotency(store, mk('{"a":1}', 'k1'), exec);
  assert.equal(calls, 1);
  assert.deepEqual(b.body, a.body);
  assert.equal(b.headers['Idempotent-Replayed'], 'true');

  await assert.rejects(withIdempotency(store, mk('{"a":2}', 'k1'), exec), (e) => e.status === 422 && e.code === 'IDEMPOTENCY_KEY_REUSED');
  await assert.rejects(withIdempotency(store, mk('{}', undefined), exec), (e) => e.status === 400 && e.code === 'IDEMPOTENCY_KEY_REQUIRED');

  // параллельные запросы с одним ключом выполняются один раз
  calls = 0;
  const [x, y] = await Promise.all([withIdempotency(store, mk('{}', 'k2'), exec), withIdempotency(store, mk('{}', 'k2'), exec)]);
  assert.equal(calls, 1);
  assert.deepEqual(x.body, y.body);
});
