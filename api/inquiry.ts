// Vercel function: POST /api/inquiry. Memory and duration limits are in vercel.json.
// All logic lives in inquiry-app/server/handler.ts; this file only wires it to the environment.
import { handlerFromEnv } from '../inquiry-app/server/fromEnv.js';

let handler: ((request: Request) => Promise<Response>) | undefined;

function getHandler(): (request: Request) => Promise<Response> {
  handler ??= handlerFromEnv();
  return handler;
}

export function POST(request: Request): Promise<Response> {
  return getHandler()(request);
}

export function OPTIONS(request: Request): Promise<Response> {
  return getHandler()(request);
}
