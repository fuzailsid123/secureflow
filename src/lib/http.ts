import { NextResponse } from 'next/server';

export const json = (data: unknown, status = 200) => NextResponse.json(data, { status });

export const badRequest = (errors: string[]) => json({ error: 'VALIDATION_FAILED', errors }, 400);

export const notFound = (what = 'Resource') => json({ error: 'NOT_FOUND', errors: [`${what} not found`] }, 404);

export const unauthorized = () => json({ error: 'UNAUTHORIZED', errors: ['Invalid or missing API key'] }, 401);

/**
 * Optional API key guard for mutating endpoints.
 * No-op unless `SECUREFLOW_API_KEY` is configured in the environment.
 */
export function requireApiKey(req: Request): NextResponse | null {
  const expected = process.env.SECUREFLOW_API_KEY;
  if (!expected) return null;
  const auth = req.headers.get('authorization');
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const headerKey = req.headers.get('x-api-key');
  if (bearer === expected || headerKey === expected) return null;
  return unauthorized();
}

/** Parses a JSON body; returns undefined if it is missing or malformed. */
export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}
