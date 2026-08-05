import { readCliConfig } from "./config.js";

export async function postJson(
  url: string,
  body: unknown,
  options: { auth?: boolean } = {}
): Promise<unknown> {
  const headers =
    options.auth === false
      ? {}
      : await authHeaders();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers
    },
    body: JSON.stringify(body)
  });

  return readJsonResponse(response);
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${text || response.statusText}`
    );
  }

  return text ? JSON.parse(text) : null;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const token = process.env.PAGELET_TOKEN ?? (await readCliConfig())?.token;
  const cloudRunToken = process.env.PAGELET_CLOUD_RUN_TOKEN?.trim();
  const headers: Record<string, string> = {};

  if (cloudRunToken) {
    headers["X-Serverless-Authorization"] = `Bearer ${cloudRunToken}`;

    if (token) {
      headers["X-Pagelet-Token"] = token;
    }
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}
