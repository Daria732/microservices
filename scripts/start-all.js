'use strict';
/** Локальный запуск всей системы без Docker: node scripts/start-all.js */
const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.join(__dirname, '..');
const procs = [
  ['message-broker', 'mocks/message-broker/index.js'],
  ['profile-service', 'services/profile-service/index.js'],
  ['food-service', 'services/food-service/index.js'],
  ['diary-service', 'services/diary-service/index.js'],
  ['nutrition-service', 'services/nutrition-service/index.js'],
  ['recommendation-service', 'services/recommendation-service/index.js'],
  ['api-gateway', 'services/api-gateway/index.js'],
];
const children = procs.map(([name, file]) => {
  const c = spawn(process.execPath, [path.join(root, file)], { stdio: 'inherit', env: process.env });
  c.on('exit', (code) => console.log(`[start-all] ${name} завершился с кодом ${code}`));
  return c;
});
const stop = () => { children.forEach((c) => c.kill('SIGTERM')); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
console.log('[start-all] запущено: gateway :8080, profile :3001, food :3002, diary :3003, nutrition :3004, recommendation :3005, broker :3100');
