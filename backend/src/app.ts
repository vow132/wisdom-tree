import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import type { PoolLike } from './types.js';
import { readConfig, type AppConfig } from './config.js';
import { AppError, fail } from './security.js';
import { Services } from './services.js';
import { registerAuth } from './auth.js';
import { registerGame } from './game.js';
import { registerAdmin } from './admin.js';
import { registerSimulator } from './simulator.js';
import { simulatorServices } from './billing.js';

export async function buildApp({ pool, config = {} }: { pool: PoolLike; config?: Partial<AppConfig> }): Promise<FastifyInstance> {
  const settings = readConfig(config);
  const app = Fastify({ logger: false, bodyLimit: 1000000, trustProxy: process.env.TRUST_PROXY === 'true' });
  await app.register(cookie);
  const allowedOrigins = new Set([settings.publicOrigin]);
  if (settings.development) { allowedOrigins.add('http://localhost:5173'); allowedOrigins.add('http://127.0.0.1:5173'); }
  app.addHook('onRequest', async request => {
    if (request.url.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (!origin || !allowedOrigins.has(origin)) fail(403, 'invalid_origin', '此请求来源不受信任。');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const code = (error as any).code;
    if (code === '23505') return reply.code(409).send({ error: { code: 'already_exists', message: '账号、模型或身份已存在。' } });
    if (code === '22P02' || code === '23514') return reply.code(400).send({ error: { code: 'invalid_request', message: '请求参数无效。' } });
    const status = Number.isInteger((error as any).statusCode) ? (error as any).statusCode : 500;
    if (status >= 500) app.log.error({ code, method: request.method, path: request.url.split('?')[0] }, 'Request failed');
    return reply.code(status).send({ error: { code: error instanceof AppError ? error.code : status >= 500 ? 'internal_error' : code || 'invalid_request', message: status >= 500 ? '服务暂时不可用，请稍后再试。' : error instanceof Error ? error.message : '请求参数无效。' } });
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: { code: 'not_found', message: '接口不存在。' } }));
  const services = new Services(pool, settings);
  await registerAuth(app, services);
  await registerGame(app, services);
  await registerAdmin(app, services);
  await registerSimulator(app, simulatorServices(services));
  return app;
}
