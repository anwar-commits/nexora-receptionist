import { runMigrations } from '@dr/db';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Creates a throwaway database, applies all migrations as the schema owner, and gives
 * the tests a URL for a restricted login (member of app_api, so row-level security applies).
 *   TEST_ADMIN_DATABASE_URL  superuser URL to the "postgres" database (default: local 5432)
 */
const ADMIN = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const API_LOGIN = 'dr_test_api';
const API_PASSWORD = 'dr_test_api_pw';

export default async function setup(project: TestProject) {
  const dbName = `dr_test_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${API_LOGIN}') THEN
      CREATE ROLE ${API_LOGIN} LOGIN PASSWORD '${API_PASSWORD}';
    END IF; END $$;`);
  await admin.end();

  const ownerUrl = new URL(ADMIN);
  ownerUrl.pathname = `/${dbName}`;
  await runMigrations({ databaseUrl: ownerUrl.toString(), apiLogin: API_LOGIN, log: () => {} });

  const apiUrl = new URL(ownerUrl);
  apiUrl.username = API_LOGIN;
  apiUrl.password = API_PASSWORD;
  project.provide('apiDatabaseUrl', apiUrl.toString());
  project.provide('ownerDatabaseUrl', ownerUrl.toString());

  return async () => {
    const c = new pg.Client({ connectionString: ADMIN });
    await c.connect();
    await c.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}' AND pid <> pg_backend_pid()`);
    await c.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await c.end();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    apiDatabaseUrl: string;
    ownerDatabaseUrl: string;
  }
}
