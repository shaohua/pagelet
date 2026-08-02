import {
  pollCliLoginResponseSchema,
  startCliLoginResponseSchema,
  type PollCliLoginRequest,
  type PollCliLoginResponse,
  type StartCliLoginRequest,
  type StartCliLoginResponse
} from "@pagelet/shared";
import { postJson } from "./http.js";
import { sleep } from "./wait.js";

export async function startCliLogin(
  apiBaseUrl: string,
  request: StartCliLoginRequest
): Promise<StartCliLoginResponse> {
  const response = await postJson(
    `${apiBaseUrl}/api/cli-login/start`,
    request,
    { auth: false }
  );
  return startCliLoginResponseSchema.parse(response);
}

export async function pollCliLogin(
  apiBaseUrl: string,
  request: PollCliLoginRequest
): Promise<PollCliLoginResponse> {
  const response = await postJson(
    `${apiBaseUrl}/api/cli-login/poll`,
    request,
    { auth: false }
  );
  return pollCliLoginResponseSchema.parse(response);
}

export async function pollUntilComplete(
  apiBaseUrl: string,
  login: StartCliLoginResponse
): Promise<PollCliLoginResponse> {
  const expiresAt = Date.parse(login.expiresAt);

  while (Date.now() < expiresAt) {
    await sleep(2000);
    const result = await pollCliLogin(apiBaseUrl, {
      userCode: login.userCode
    });

    if (result.status !== "pending") {
      return result;
    }
  }

  return { status: "expired" };
}
