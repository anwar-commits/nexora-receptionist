import type { Db } from '@dr/db';
import type { Logger } from 'pino';
import type { Config } from './config.js';
import type { SmsProvider } from './lib/sms.js';
import type { VoiceVendor } from './voice/elevenlabs.js';
import type { Llm } from './voice/llm.js';
import type { ObjectStore } from './voice/recordings.js';

export interface Deps {
  config: Config;
  db: Db;
  sms: SmsProvider;
  log: Logger;
  /** The receptionist's model. Absent = no model configured: the AI cannot be tested or go live. */
  llm?: Llm;
  /** ElevenLabs. Absent = not configured: agents can be published but not connected to phones. */
  voice?: VoiceVendor;
  recordings?: ObjectStore;
}

export type Scope = 'org' | 'branch' | 'own' | 'assigned';
export interface Grant { scope: Scope; limit: number | null }

/** Attached to each request by the auth and organization middleware. */
export interface RequestContext {
  userId: string;
  sessionId: string;
  mfaVerified: boolean;
  ip: string;
  org?: {
    id: string;
    membershipId: string;
    roleId: string;
    roleKey: string;
    branchIds: string[];
    grants: Map<string, Grant>;
  };
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx?: RequestContext;
      rawBody?: Buffer;
    }
  }
}
