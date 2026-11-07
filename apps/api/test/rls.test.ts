import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { makeApp, ownerWithClinic, type TestApp } from './helpers.js';

/**
 * Talks to PostgreSQL directly as the API's login, bypassing the API's own checks,
 * to prove the database itself keeps clinics apart.
 */
let t: TestApp;
let a: Awaited<ReturnType<typeof ownerWithClinic>>;
let b: Awaited<ReturnType<typeof ownerWithClinic>>;
let client: pg.Client;

beforeAll(async () => {
  t = makeApp();
  a = await ownerWithClinic(t, 'Clinic A');
  b = await ownerWithClinic(t, 'Clinic B');
  client = new pg.Client({ connectionString: inject('apiDatabaseUrl') });
  await client.connect();
});
afterAll(async () => {
  await client.end();
  await t.close();
});

async function asOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    return await fn();
  } finally {
    await client.query('ROLLBACK');
  }
}

describe('row-level security', () => {
  it('returns no clinic rows when no clinic is set', async () => {
    const r = await client.query('SELECT count(*)::int AS n FROM app.branches');
    expect(r.rows[0].n).toBe(0);
    const m = await client.query('SELECT count(*)::int AS n FROM app.memberships');
    expect(m.rows[0].n).toBe(0);
  });

  it("shows a clinic only its own rows", async () => {
    const ids = await asOrg(a.orgId, async () => (await client.query('SELECT organization_id FROM app.branches')).rows.map((r) => r.organization_id));
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set([a.orgId]));
  });

  it("refuses writes into another clinic", async () => {
    await expect(asOrg(a.orgId, () => client.query(
      "INSERT INTO app.branches (organization_id, name, address_line, city, state) VALUES ($1, 'Sneaky', 'x', 'Patna', 'Bihar')", [b.orgId],
    ))).rejects.toThrow(/row-level security/);
  });

  it("cannot move a row to another clinic", async () => {
    await expect(asOrg(a.orgId, () => client.query('UPDATE app.branches SET organization_id = $1', [b.orgId])))
      .rejects.toThrow(/row-level security/);
  });

  it('cannot edit or delete the audit log', async () => {
    await expect(client.query('UPDATE app.audit_logs SET action = $1', ['tampered'])).rejects.toThrow(/permission denied/);
    await expect(client.query('DELETE FROM app.audit_logs')).rejects.toThrow(/permission denied/);
  });

  it('cannot change the permission catalogue', async () => {
    await expect(client.query("INSERT INTO app.permissions (key, description) VALUES ('x:y', 'x')")).rejects.toThrow(/permission denied/);
  });

  it('is not a superuser and cannot bypass row-level security', async () => {
    const r = await client.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user');
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });
});
