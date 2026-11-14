export interface ApiBody {
  error?: string;
  errors?: string[];
  cycle?: string[];
  message?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiBody,
  ) {
    super(body.errors?.[0] ?? body.message ?? `Request failed (${status})`);
    this.name = 'ApiError';
  }
}

/** Small fetch wrapper: JSON in, JSON out, non-2xx responses become ApiError carrying the parsed body. */
export async function api<T>(url: string, init: Omit<RequestInit, 'body'> & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(url, {
    ...rest,
    headers: { 'Content-Type': 'application/json', ...(rest.headers ?? {}) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(res.status, (data ?? {}) as ApiBody);
  return data as T;
}

export const errorText = (e: unknown): string => (e instanceof Error ? e.message : 'Something went wrong');

/** Triggers a browser file download of a JSON-serializable object. */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
