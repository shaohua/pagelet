import type { Organization, User } from "@pagelet/shared";
import { demoOrganization, demoUser } from "@pagelet/shared";
import { loadIdentityByIds, verifyCliToken } from "./auth-repository";
import { getAllowedEmailDomains } from "./config";
import { readSessionPayload } from "./session";

export type AuthenticatedSession = {
  user: User;
  organization: Organization;
  method: "cli_token" | "dev_cli_token" | "dev_web" | "web_session";
};

type AuthOptions = {
  allowCliToken: boolean;
  allowDevWeb: boolean;
  allowWebSession: boolean;
};

export async function requireCliAuth(request: Request): Promise<AuthenticatedSession> {
  return requireAuth(request, {
    allowCliToken: true,
    allowDevWeb: false,
    allowWebSession: false
  });
}

export async function requirePageletAccess(
  request: Request
): Promise<AuthenticatedSession> {
  return requireAuth(request, {
    allowCliToken: true,
    allowDevWeb: true,
    allowWebSession: true
  });
}

export function assertDevAuthProductionGuard(): void {
  if (
    process.env.NODE_ENV === "production" &&
    process.env.PAGELET_DEV_AUTH === "1" &&
    process.env.PAGELET_DEPLOY_AUTH_MODE !== "dev-preview"
  ) {
    throw new Error("PAGELET_DEV_AUTH=1 is not allowed when NODE_ENV=production");
  }
}

export function assertAllowedEmailDomain(
  user: User,
  allowedDomains = getAllowedEmailDomains()
): void {
  assertAllowedEmailDomainForEmail(user.email, allowedDomains);
}

export function assertAllowedEmailDomainForEmail(
  email: string,
  allowedDomains = getAllowedEmailDomains()
): void {
  const domain = email.split("@").pop()?.toLowerCase();

  if (!domain || !allowedDomains.includes(domain)) {
    throw new Response("Email domain is not allowed", { status: 403 });
  }
}

async function requireAuth(
  request: Request,
  options: AuthOptions
): Promise<AuthenticatedSession> {
  assertDevAuthProductionGuard();
  const token = bearerToken(request);

  if (options.allowCliToken && token) {
    const verifiedToken = await verifyCliToken(token);

    if (verifiedToken) {
      assertAllowedEmailDomain(verifiedToken.user);
      return {
        ...verifiedToken,
        method: "cli_token"
      };
    }
  }

  if (options.allowWebSession) {
    const sessionPayload = readSessionPayload(request);

    if (sessionPayload) {
      const identity = await loadIdentityByIds(
        sessionPayload.userId,
        sessionPayload.orgId
      );

      if (identity) {
        assertAllowedEmailDomain(identity.user);
        return {
          ...identity,
          method: "web_session"
        };
      }
    }
  }

  if (isDevAuthEnabled()) {
    if (options.allowCliToken && token && token === expectedDevToken()) {
      return devSession("dev_cli_token");
    }

    if (options.allowDevWeb && !token) {
      return devSession("dev_web");
    }
  }

  throw new Response("Authentication required", { status: 401 });
}

function devSession(method: AuthenticatedSession["method"]): AuthenticatedSession {
  assertAllowedEmailDomain(demoUser);
  return {
    user: demoUser,
    organization: demoOrganization,
    method
  };
}

function isDevAuthEnabled(): boolean {
  if (process.env.PAGELET_DEV_AUTH === "1") {
    return true;
  }

  if (process.env.PAGELET_DEV_AUTH === "0") {
    return false;
  }

  return process.env.NODE_ENV !== "production";
}

function expectedDevToken(): string {
  return process.env.PAGELET_DEV_TOKEN ?? "dev-token";
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");

  if (!header) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() || null;
}
