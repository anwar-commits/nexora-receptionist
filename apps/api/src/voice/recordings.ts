import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { decryptBytes, encryptBytes } from '../lib/crypto.js';

/**
 * Call audio, encrypted at rest with the data key (AES-256-GCM). Local disk for self-hosted
 * and staging; an S3-compatible store implements the same interface in production.
 */
export interface ObjectStore {
  put(key: string, data: Buffer): Promise<number>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
}

const SAFE_KEY = /^[a-z0-9][a-z0-9/_.-]*$/i;

export class LocalEncryptedStore implements ObjectStore {
  private readonly root: string;
  constructor(root: string, private readonly key: Buffer) { this.root = resolve(root); }
  private path(key: string) {
    if (!SAFE_KEY.test(key) || key.includes('..')) throw new Error('invalid object key');
    return join(this.root, `${key}.enc`);
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const blob = encryptBytes(this.key, data);
    await writeFile(p, blob, { mode: 0o600 });
    return blob.length;
  }
  async get(key: string) { return decryptBytes(this.key, await readFile(this.path(key))); }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}
