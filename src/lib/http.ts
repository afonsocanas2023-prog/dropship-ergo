import { type Result, ok, err } from "./result";
import { logger } from "./logger";

export interface HttpError {
  status?: number;
  message: string;
  body?: unknown;
}

export interface RequestOptions extends RequestInit {
  retries?: number;
  backoffMs?: number;
}

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseBody(response: Response): Promise<unknown> {
  const ct = response.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

export async function httpRequest<T>(
  url: string,
  { retries = DEFAULT_RETRIES, backoffMs = DEFAULT_BACKOFF_MS, ...init }: RequestOptions = {},
): Promise<Result<T, HttpError>> {
  let lastError: HttpError = { message: "Unknown error" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = backoffMs * 2 ** (attempt - 1);
      logger.warn("http retry", { url, attempt, delayMs: delay });
      await sleep(delay);
    }

    try {
      const response = await fetch(url, init);

      if (!response.ok) {
        const body = await parseBody(response).catch(() => undefined);
        lastError = { status: response.status, message: response.statusText, body };
        // 4xx are client errors — retrying won't help
        if (response.status >= 400 && response.status < 500) {
          return err(lastError);
        }
        logger.warn("http server error", { url, status: response.status, attempt });
        continue;
      }

      const data = (await parseBody(response)) as T;
      return ok(data);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      lastError = { message };
      logger.error("http request threw", { url, attempt, error: message });
    }
  }

  return err(lastError);
}

// Convenience wrappers for JSON APIs
export async function httpGet<T>(
  url: string,
  headers?: Record<string, string>,
  options?: Omit<RequestOptions, "method" | "body">,
): Promise<Result<T, HttpError>> {
  return httpRequest<T>(url, { method: "GET", headers, ...options });
}

export async function httpPost<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
  options?: Omit<RequestOptions, "method" | "body">,
): Promise<Result<T, HttpError>> {
  return httpRequest<T>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...options,
  });
}

export async function httpPut<T>(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
  options?: Omit<RequestOptions, "method" | "body">,
): Promise<Result<T, HttpError>> {
  return httpRequest<T>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    ...options,
  });
}
