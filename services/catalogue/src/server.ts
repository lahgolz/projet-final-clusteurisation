import { createLogger } from '@microservice-app/shared';
import { loadConfig } from './config.js';
import { createPool, warmPool } from './db.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger('catalogue', config.logLevel);
  const pool = createPool(config);

  try {
    await warmPool(pool, config.dbPoolMin);
  } catch (error) {
    logger.warn({ err: error }, 'pool_warmup_failed');
  }

  const app = buildApp({ pool, logger });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting_down');

    const forceExitTimer = setTimeout(() => {
      logger.error('graceful_shutdown_timeout_exceeded');
      process.exit(1);
    }, 10_000);
    forceExitTimer.unref();

    try {
      await app.close();
      await pool.end();
      logger.info('shutdown_complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'shutdown_failed');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' });
  } catch (error) {
    logger.error({ err: error }, 'failed_to_start');
    process.exit(1);
  }
}

void main();
