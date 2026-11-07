import { createDb } from '@dr/db';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ConsoleSms, MemorySms } from './lib/sms.js';

const config = loadConfig();
const log = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });
const db = createDb(config.DATABASE_URL);
const sms = config.SMS_PROVIDER === 'memory' ? new MemorySms() : new ConsoleSms(log);

const app = createApp({ config, db, sms, log });
const server = app.listen(config.PORT, () => log.info(`API listening on :${config.PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => void db.close().then(() => process.exit(0)));
  });
}
