import express from 'express';
import helmet from 'helmet';
import { errorHandler, notFoundHandler } from './errors.js';
import { requestContext } from './logger.js';
import { limiter, requireJson } from './middleware.js';
import { authRoutes } from './routes/auth.js';
import { catalogueRoutes } from './routes/catalogue.js';
import { checkoutRoutes } from './routes/checkout.js';
import { orderRoutes } from './routes/orders.js';

/**
 * Builds the Express app. All collaborators are injected so tests can use
 * a real database with a mock card processor.
 *
 * @param {{config: object, logger: object, services: object}} deps
 */
export function createApp({ config, logger, services }) {
  const app = express();
  app.disable('x-powered-by');
  // Rate limiting and login auditing use req.ip. Enable only behind a trusted reverse proxy.
  app.set('trust proxy', false);

  app.use(requestContext(logger));
  app.use(helmet());
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(limiter(config.rateLimitGeneralPerMin));
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use(requireJson);

  // Liveness only: no dependencies, no information.
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));

  app.use('/api/auth', limiter(config.rateLimitAuthPerMin), authRoutes(services));
  app.use('/api', catalogueRoutes(services));
  app.use('/api', orderRoutes(services));
  app.use('/api', checkoutRoutes(services));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
