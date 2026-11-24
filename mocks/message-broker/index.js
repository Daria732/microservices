const createBroker = require('./broker');
const app = createBroker({
  retryDelayMs: Number(process.env.RETRY_DELAY_MS) || 3000,
  maxAttempts: Number(process.env.MAX_ATTEMPTS) || 5,
  logLevel: process.env.LOG_LEVEL || 'info',
});
app.listen(Number(process.env.PORT) || 3100);
const stop = () => app.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
