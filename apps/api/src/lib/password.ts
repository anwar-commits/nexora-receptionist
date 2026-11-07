import { hash, verify } from '@node-rs/argon2';

// OWASP-recommended argon2id parameters (19 MiB, 2 iterations).
const opts = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (pw: string) => hash(pw, opts);

export async function verifyPassword(stored: string | null, pw: string): Promise<boolean> {
  if (!stored) {
    // Spend the same time as a real check so missing accounts are not detectable by timing.
    await hash(pw, opts);
    return false;
  }
  try {
    return await verify(stored, pw);
  } catch {
    return false;
  }
}
