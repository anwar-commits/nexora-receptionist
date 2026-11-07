import type { Logger } from 'pino';

/** Sends one-time codes. Real providers (DLT-registered templates) are added in Phase 13. */
export interface SmsProvider {
  readonly name: string;
  sendOtp(phoneE164: string, code: string, purpose: string): Promise<void>;
}

/** Development only: writes the code to the server log. Refused in production by config. */
export class ConsoleSms implements SmsProvider {
  readonly name = 'console';
  constructor(private log: Logger) {}
  async sendOtp(phone: string, code: string, purpose: string) {
    this.log.warn({ phone, purpose }, `DEV ONLY one-time code: ${code}`);
  }
}

/** Tests: keeps the last code per number so a test can complete the flow. */
export class MemorySms implements SmsProvider {
  readonly name = 'memory';
  readonly sent = new Map<string, string>();
  async sendOtp(phone: string, code: string) {
    this.sent.set(phone, code);
  }
}
