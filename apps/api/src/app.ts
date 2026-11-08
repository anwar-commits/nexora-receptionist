import cors from 'cors';
import express, { Router } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Deps } from './context.js';
import { HttpError } from './errors.js';
import { errorHandler } from './middleware.js';
import { identityRouter, meRouter } from './modules/identity.js';
import { crmRouter } from './modules/crm.js';
import { inboxRouter } from './modules/inbox.js';
import { receptionRouter } from './modules/reception.js';
import { schedulingRouter } from './modules/scheduling.js';
import { setupRouter } from './modules/setup.js';
import { tenancyRouter } from './modules/tenancy.js';

export function createApp(deps: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind one load balancer in production

  app.use(helmet());
  app.use(cors({ origin: deps.config.WEB_ORIGIN.split(','), credentials: false, allowedHeaders: ['Authorization', 'Content-Type', 'X-Org-Id', 'Idempotency-Key'] }));
  // Keep the raw bytes: webhook signatures are computed over them, not over re-serialised JSON.
  app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  if (deps.config.NODE_ENV !== 'test') {
    app.use(pinoHttp({
      logger: deps.log,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      customProps: (req) => ({ userId: (req as express.Request).ctx?.userId }),
    }));
  }

  app.get('/health', async (_req, res) => {
    await deps.db.sequelize.query('SELECT 1');
    res.json({ status: 'ok' });
  });

  const v1 = Router();
  const authLimiter = rateLimit({
    windowMs: 60_000,
    limit: deps.config.AUTH_RATE_LIMIT_PER_MIN,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: () => { throw new HttpError(429, 'rate_limited', 'Too many attempts. Wait a minute and try again.'); },
  });
  v1.use('/auth', authLimiter, identityRouter(deps));
  v1.use('/me', meRouter(deps));
  v1.use('/', tenancyRouter(deps));
  v1.use('/', setupRouter(deps));
  v1.use('/', schedulingRouter(deps));
  v1.use('/', crmRouter(deps));
  v1.use('/', receptionRouter(deps));
  v1.use('/', inboxRouter(deps));
  app.use('/v1', v1);

  app.use((_req, _res, next) => next(new HttpError(404, 'not_found', 'No such endpoint')));
  app.use(errorHandler(deps));
  return app;
}
