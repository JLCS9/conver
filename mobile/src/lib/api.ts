// Typed fetch wrapper for the Converflow backend.
// Automatically attaches a Clerk Bearer token when `getToken` is provided.

const API_URL = process.env.EXPO_PUBLIC_API_URL;

if (!API_URL) {
  console.warn("EXPO_PUBLIC_API_URL is not set — API calls will fail.");
}

type FetchOpts = Omit<RequestInit, "headers"> & {
  headers?: Record<string, string>;
  getToken?: () => Promise<string | null>;
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

  const res = await fetch(`${API_URL}${path}`, { ...opts, headers });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`API ${path} ${res.status}: ${text.slice(0, 200)}`);
  }

  return (await res.json()) as T;
}
