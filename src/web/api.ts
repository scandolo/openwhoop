import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    credentials: "same-origin",
    ...rest,
    headers: { ...(json !== undefined ? { "content-type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  if (res.status === 401) window.dispatchEvent(new Event("ow:unauthorized"));
  const ct = res.headers.get("content-type") ?? "";
  const body = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string })?.error ?? String(body));
  return body as T;
}

/** Fetch on mount / when `path` changes; `reload()` refetches; listens to "ow:data" to refresh after syncs. */
export function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: !!path });
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const id = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((data) => id === seq.current && setState({ data, error: null, loading: false }))
      .catch((e: Error) => id === seq.current && setState((s) => ({ ...s, error: e.message, loading: false })));
  }, [path]);
  useEffect(() => {
    load();
    const on = () => load();
    window.addEventListener("ow:data", on);
    return () => window.removeEventListener("ow:data", on);
  }, [load]);
  return { ...state, reload: load };
}

export const dataChanged = () => window.dispatchEvent(new Event("ow:data"));
