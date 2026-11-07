import { z } from 'zod';

const base64Key = z
  .string()
  .min(1)
  .refine((v) => Buffer.from(v, 'base64').length >= 32, 'must be at least 32 bytes, base64-encoded');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: base64Key,
  DATA_ENCRYPTION_KEY: base64Key,
  HASH_PEPPER: base64Key,
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SMS_PROVIDER: z.enum(['console', 'memory']).default('console'),
  AUTH_RATE_LIMIT_PER_MIN: z.coerce.number().int().default(30),
});

export type Config = z.infer<typeof schema> & {
  jwtKey: Uint8Array;
  dataKey: Buffer;
  pepper: Buffer;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    // The only SMS providers so far log or store codes. A real one arrives in Phase 13.
    throw new Error(`SMS_PROVIDER=${c.SMS_PROVIDER} does not send real SMS and is not allowed in production`);
  }
  return {
    ...c,
    jwtKey: new Uint8Array(Buffer.from(c.JWT_SECRET, 'base64')),
    dataKey: Buffer.from(c.DATA_ENCRYPTION_KEY, 'base64').subarray(0, 32),
    pepper: Buffer.from(c.HASH_PEPPER, 'base64'),
  };
}
