'use strict';
const createBroker = require('../mocks/message-broker/broker');
const createProfile = require('../services/profile-service/app');
const createFood = require('../services/food-service/app');
const createDiary = require('../services/diary-service/app');
const createNutrition = require('../services/nutrition-service/app');
const createRecommendation = require('../services/recommendation-service/app');
const createGateway = require('../services/api-gateway/app');

/** Поднимает всю систему в одном процессе на случайных портах. */
async function startSystem(opts = {}) {
  const logLevel = process.env.TEST_LOG || 'silent';
  const fast = { outboxIntervalMs: 50, logLevel };
  const broker = await createBroker({ retryDelayMs: opts.retryDelayMs ?? 80, maxAttempts: opts.maxAttempts ?? 5, logLevel }).listen(0);
  const brokerUrl = broker.baseUrl;
  const profile = await createProfile({ ...fast, brokerUrl }).listen(0);
  const food = await createFood({ ...fast, brokerUrl }).listen(0);
  const diary = await createDiary({ ...fast, brokerUrl, foodUrl: food.baseUrl }).listen(0);
  const nutrition = await createNutrition({ ...fast, brokerUrl, profileUrl: profile.baseUrl }).listen(0);
  const recommendation = await createRecommendation({ ...fast, brokerUrl, nutritionUrl: nutrition.baseUrl, profileUrl: profile.baseUrl }).listen(0);
  const gateway = await createGateway({
    logLevel, brokerUrl, profileUrl: profile.baseUrl, foodUrl: food.baseUrl, diaryUrl: diary.baseUrl,
    nutritionUrl: nutrition.baseUrl, recommendationUrl: recommendation.baseUrl,
  }).listen(0);
  const all = { broker, profile, food, diary, nutrition, recommendation, gateway };
  return { ...all, stop: async () => { for (const a of Object.values(all).reverse()) await a.close(); } };
}

/** HTTP-клиент: обращается к системе через Gateway. */
function client(baseUrl, userId = 'user-1') {
  return async function call(method, path, { body, key, token, headers = {} } = {}) {
    const h = { ...headers };
    const tok = token === undefined ? `Bearer mock-jwt-${userId}` : token;
    if (tok) h.Authorization = tok;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    if (key) h['Idempotency-Key'] = key;
    const res = await fetch(baseUrl + path, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : undefined; } catch (_) { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
}

async function waitFor(fn, { timeout = 4000, interval = 30 } = {}) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error('waitFor: условие не выполнилось за отведённое время');
}

const post = (call, path, body, key) => call('POST', path, { body, key });
module.exports = { startSystem, client, waitFor, post };
