import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** Folder holding the numbered .sql migrations (works from src/ and dist/). */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrateOptions {
  /** Connection string of the schema owner (never the API login). */
  databaseUrl: string;
  /** Login role the API connects as; it is granted membership of app_api. */
  apiLogin?: string;
  log?: (msg: string) => void;
}

/**
 * Applies every migration in MIGRATIONS_DIR that has not run yet, each in its own
 * transaction, in file-name order. Migrations are plain SQL because row-level security,
 * exclusion constraints and policies are clearer in SQL than in an ORM's DSL.
 */
export async function runMigrations({ databaseUrl, apiLogin, log = console.log }: MigrateOptions): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM public.schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO public.schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`applied ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
    }
    if (apiLogin) {
      if (!/^[a-z_][a-z0-9_]*$/.test(apiLogin)) throw new Error('API_DB_LOGIN must be a plain role name');
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [apiLogin]);
      if (exists.rowCount) {
        await client.query(`GRANT app_api TO ${apiLogin}`);
        const sup = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [apiLogin]);
        const r = sup.rows[0];
        if (r?.rolsuper || r?.rolbypassrls) throw new Error(`${apiLogin} is superuser or BYPASSRLS; the API login must be subject to row-level security`);
      } else {
        log(`warning: login role ${apiLogin} does not exist yet; create it, then run migrate again`);
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}
