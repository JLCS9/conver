// Typed fetch wrapper for the Converflow backend.
// Automatically attaches a Clerk Bearer token when `getToken` is provided.

const API_URL = process.env.EXPO_PUBLIC_API_URL;

if (!API_URL) {
  console.warn("EXPO_PUBLIC_API_URL is not set — API calls will fail.");
}

type FetchOpts = Omit<RequestInit, "headers" | "signal"> & {
  headers?: Record<string, string>;
  getToken?: () => Promise<string | null>;
  /** Per-call timeout in ms. Default 15s — long enough for slow networks,
      short enough that a hung request doesn't look like the app froze. */
  timeoutMs?: number;
};

export async function api<T = unknown>(
  path: string,
  opts: FetchOpts = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers ?? {}),
  };

  if (opts.getToken) {
    const token = await opts.getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  // Build the actual RequestInit explicitly so we don't accidentally pass
  // `getToken`, `timeoutMs`, or anything else fetch doesn't understand
  // through the {...opts} spread. Some RN networking layers misbehave with
  // unknown options.
  const requestInit: RequestInit = {
    method: opts.method ?? "GET",
    headers,
  };
  if (opts.body !== undefined) requestInit.body = opts.body;
  if (opts.credentials !== undefined) requestInit.credentials = opts.credentials;
  if (opts.cache !== undefined) requestInit.cache = opts.cache;
  if (opts.mode !== undefined) requestInit.mode = opts.mode;
  if (opts.referrer !== undefined) requestInit.referrer = opts.referrer;
  if (opts.redirect !== undefined) requestInit.redirect = opts.redirect;

  const timeoutMs = opts.timeoutMs ?? 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  requestInit.signal = controller.signal;

  const url = `${API_URL}${path}`;
  const t0 = Date.now();
  console.log(`[api] → ${requestInit.method} ${path} (timeout ${timeoutMs}ms)`);

  let res: Response;
  try {
    res = await fetch(url, requestInit);
  } catch (e) {
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    const msg = (e as { message?: string }).message ?? String(e);
    if (controller.signal.aborted) {
      throw new Error(`API ${path} timed out after ${timeoutMs}ms`);
    }
    throw new Error(`API ${path} network error after ${elapsed}ms: ${msg}`);
  }
  clearTimeout(timer);

  const elapsed = Date.now() - t0;
  console.log(`[api] ← ${requestInit.method} ${path} → HTTP ${res.status} in ${elapsed}ms`);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${path} ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}
