import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { createPaymentProvider } from './payments/provider.js';
import { createAuthService } from './services/auth.js';
import { createBasketService } from './services/basket.js';
import { createCatalogueService } from './services/catalogue.js';
import { createCheckoutService } from './services/checkout.js';
import { createOrderService } from './services/orders.js';
import { createRecommendationService } from './services/recommendations.js';

/** Wires configuration, database and services into a ready-to-listen app. */
/** `overrides.provider` replaces the card processor (used by tests). */
export function buildContext(config, logger = createLogger(config.logLevel), overrides = {}) {
  const pool = createPool({ connectionString: config.databaseUrl });
  pool.on('error', (err) => logger.error({ err }, 'idle database client error'));

  const provider = overrides.provider ?? createPaymentProvider(config);
  const deps = { pool, config, logger, provider };
  const services = {
    auth: createAuthService(deps),
    catalogue: createCatalogueService(deps),
    recommendations: createRecommendationService(deps),
    basket: createBasketService(deps),
    orders: createOrderService(deps),
    checkout: createCheckoutService(deps),
  };
  return { app: createApp({ config, logger, services }), pool, logger, services, provider };
}

export function main() {
  const config = loadConfig();
  const { app, pool, logger } = buildContext(config);
  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port, env: config.env }, 'bookstore API listening');
  });

  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    server.close(() => pool.end().then(() => process.exit(0), () => process.exit(1)));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
