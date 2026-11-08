import { createDb } from '@dr/db';
import { pino } from 'pino';
import { loadConfig } from '../config.js';
import { MemorySms } from '../lib/sms.js';
import { purgeExpiredRecordings } from '../voice/postcall.js';
import { LocalEncryptedStore } from '../voice/recordings.js';

/** Daily job: removes call audio past each clinic's retention period and marks it deleted. */
const config = loadConfig();
const log = pino({ level: 'info' });
const db = createDb(config.DATABASE_URL, { poolMax: 2 });
const n = await purgeExpiredRecordings({ config, db, log, sms: new MemorySms(), recordings: new LocalEncryptedStore(config.RECORDINGS_DIR, config.dataKey) });
log.info({ deleted: n }, 'expired call recordings removed');
await db.close();
