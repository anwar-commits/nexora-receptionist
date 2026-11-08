import { createDb } from '@dr/db';
import { pino } from 'pino';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { ConsoleSms, MemorySms } from './lib/sms.js';
import { ElevenLabsClient } from './voice/elevenlabs.js';
import { AnthropicLlm } from './voice/llm.js';
import { LocalEncryptedStore } from './voice/recordings.js';

const config = loadConfig();
const log = pino({ level: config.NODE_ENV === 'production' ? 'info' : 'debug' });
const db = createDb(config.DATABASE_URL);
const sms = config.SMS_PROVIDER === 'memory' ? new MemorySms() : new ConsoleSms(log);

const llm = config.ANTHROPIC_API_KEY ? new AnthropicLlm(config.ANTHROPIC_API_KEY, config.ANTHROPIC_BASE_URL) : undefined;
const voice = config.ELEVENLABS_API_KEY ? new ElevenLabsClient(config.ELEVENLABS_API_KEY, config.ELEVENLABS_BASE_URL) : undefined;
const recordings = new LocalEncryptedStore(config.RECORDINGS_DIR, config.dataKey);
if (!llm) log.warn('ANTHROPIC_API_KEY not set: the AI receptionist cannot be tested or go live');
if (!voice) log.warn('ELEVENLABS_API_KEY not set: AI receptionist agents will not be connected to phone numbers');

const app = createApp({ config, db, sms, log, llm, voice, recordings });
const server = app.listen(config.PORT, () => log.info(`API listening on :${config.PORT}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close(() => void db.close().then(() => process.exit(0)));
  });
}
