import { createNamespace } from 'cls-hooked';
import { Sequelize, type Transaction } from 'sequelize';
import { initModels } from './models.js';

export * from './models.js';
export { runMigrations, MIGRATIONS_DIR } from './migrate.js';
export { Op, QueryTypes, UniqueConstraintError, type Transaction } from 'sequelize';

// Every query inside withContext() automatically joins its transaction (CLS),
// so a forgotten { transaction } option cannot silently run without tenant scope.
const namespace = createNamespace('dr-db');
Sequelize.useCLS(namespace);

export interface DbContext {
  /** Clinic the request acts for. Empty means no clinic: tenant tables return nothing. */
  orgId?: string | null;
  /** Signed-in user, used by the "my own memberships" read policies. */
  userId?: string | null;
}

export interface Db {
  sequelize: Sequelize;
  /**
   * Runs fn in a transaction with the tenant context set via set_config(..., true),
   * so it lasts exactly as long as the transaction. Row-level security reads it.
   */
  withContext<T>(ctx: DbContext, fn: (t: Transaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createDb(databaseUrl: string, opts: { logging?: boolean; poolMax?: number } = {}): Db {
  const sequelize = new Sequelize(databaseUrl, {
    dialect: 'postgres',
    logging: opts.logging ? console.log : false,
    pool: { max: opts.poolMax ?? 10, idle: 10_000 },
    define: { underscored: true },
  });
  initModels(sequelize);

  return {
    sequelize,
    async withContext(ctx, fn) {
      for (const v of [ctx.orgId, ctx.userId]) {
        if (v && !UUID.test(v)) throw new Error('invalid context id');
      }
      return sequelize.transaction(async (t) => {
        await sequelize.query(
          "SELECT set_config('app.org_id', :org, true), set_config('app.user_id', :user, true)",
          { replacements: { org: ctx.orgId ?? '', user: ctx.userId ?? '' }, transaction: t },
        );
        return fn(t);
      });
    },
    close: () => sequelize.close(),
  };
}
