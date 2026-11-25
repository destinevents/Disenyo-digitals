/// <reference types="vitest/config" />
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite';

/**
 * Serves api/inquiry.ts during `npm run dev`, so the chat works locally without `vercel dev`.
 * Production uses the Vercel function directly; this plugin is dev-only.
 */
function devApi(): Plugin {
  return {
    name: 'disenyo-dev-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      Object.assign(process.env, loadEnv(server.config.mode, server.config.root, ''));

      server.middlewares.use('/api/inquiry', async (req: IncomingMessage, res: ServerResponse) => {
        try {
          const mod = (await server.ssrLoadModule(path.resolve(server.config.root, '../api/inquiry.ts'))) as Record<string, (r: Request) => Promise<Response>>;
          const handler = mod[req.method ?? ''];
          if (!handler) {
            res.statusCode = 405;
            res.end();
            return;
          }

          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk as Buffer);
          const headers = new Headers();
          for (const [key, value] of Object.entries(req.headers)) {
            if (typeof value === 'string') headers.set(key, value);
          }
          headers.set('x-forwarded-for', req.socket.remoteAddress ?? '127.0.0.1');

          const request = new Request(`http://${req.headers.host}/api/inquiry`, {
            method: req.method,
            headers,
            body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
          });
          const response = await handler(request);
          res.statusCode = response.status;
          response.headers.forEach((value, key) => res.setHeader(key, value));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (error) {
          server.config.logger.error(String(error));
          res.statusCode = 500;
          res.end();
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  // The chat page is served by disenyodigitals.com at /inquire/ (built into ../inquire).
  base: '/inquire/',
  build: {
    target: 'es2020',
    outDir: '../inquire',
    emptyOutDir: true,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
