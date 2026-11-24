'use strict';
/** Запуск сервиса из переменных окружения (используется в index.js каждого сервиса). */
function bootstrap(createService, defaultPort) {
  const app = createService({
    brokerUrl: process.env.BROKER_URL || 'http://localhost:3100',
    selfUrl: process.env.SELF_URL,
    foodUrl: process.env.FOOD_SERVICE_URL || 'http://localhost:3002',
    profileUrl: process.env.PROFILE_SERVICE_URL || 'http://localhost:3001',
    diaryUrl: process.env.DIARY_SERVICE_URL || 'http://localhost:3003',
    nutritionUrl: process.env.NUTRITION_SERVICE_URL || 'http://localhost:3004',
    recommendationUrl: process.env.RECOMMENDATION_SERVICE_URL || 'http://localhost:3005',
    logLevel: process.env.LOG_LEVEL || 'info',
  });
  app.listen(Number(process.env.PORT) || defaultPort).catch((e) => { console.error(e); process.exit(1); });
  const stop = () => app.close().finally(() => process.exit(0));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
module.exports = { bootstrap };
