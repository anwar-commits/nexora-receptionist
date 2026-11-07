import { runMigrations } from './migrate.js';

const databaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!databaseUrl) {
  console.error('MIGRATION_DATABASE_URL is not set');
  process.exit(1);
}
runMigrations({ databaseUrl, apiLogin: process.env.API_DB_LOGIN })
  .then((applied) => console.log(applied.length ? `${applied.length} migration(s) applied` : 'database is up to date'))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
