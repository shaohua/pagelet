import { randomUUID } from "node:crypto";
import type {
  Organization,
  PollCliLoginRequest,
  PollCliLoginResponse,
  StartCliLoginRequest,
  StartCliLoginResponse,
  User
} from "@pagelet/shared";
import { demoOrganization, demoUser } from "@pagelet/shared";
import {
  createCliToken,
  createUserCode,
  hashSecret,
  normalizeUserCode
} from "./auth-crypto";
import { getAllowedEmailDomains } from "./config";
import { getDocumentStore } from "./document-store";
import type { AuthIdentity, UpsertIdentityRequest } from "./auth-repository";

export { hashSecret } from "./auth-crypto";

type CliLoginSession = {
  id: string;
  userCodeHash: string;
  label: string | null;
  status: "pending" | "approved" | "consumed";
  identity?: AuthIdentity;
  createdAt: string;
  expiresAt: string;
};

type CliTokenRecord = {
  id: string;
  orgId: string;
  userId: string;
  tokenHash: string;
  label: string | null;
  identity?: AuthIdentity;
  createdAt: string;
  lastUsedAt: string | null;
};

type AuthData = {
  loginSessions: CliLoginSession[];
  cliTokens: CliTokenRecord[];
  organizations?: Organization[];
  users?: User[];
};

const AUTH_KEY = "auth";

export async function startCliLogin(
  request: StartCliLoginRequest,
  appBaseUrl: string
): Promise<StartCliLoginResponse> {
  const now = new Date();
  const userCode = createUserCode();
  const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();

  await updateAuthData((data) => {
    data.loginSessions.push({
      id: randomUUID(),
      userCodeHash: hashSecret(userCode),
      label: request.label ?? null,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt
    });
  });

  return {
    verificationUrl: `${appBaseUrl}/cli-login/${userCode}`,
    userCode,
    pollUrl: `${appBaseUrl}/api/cli-login/poll`,
    expiresAt
  };
}

export async function confirmCliLogin(
  userCode: string,
  identity: AuthIdentity
): Promise<void> {
  await updateAuthData((data) => {
    const session = findLoginSession(data, userCode);

    if (!session || isExpired(session)) {
      throw new Response("CLI login session expired", { status: 410 });
    }

    if (session.status !== "pending") {
      throw new Response("CLI login session is not pending", { status: 400 });
    }

    ensureIdentity(data, identity);
    session.status = "approved";
    session.identity = identity;
  });
}

export async function pollCliLogin(
  request: PollCliLoginRequest
): Promise<PollCliLoginResponse> {
  const token = createCliToken();

  return updateAuthData<PollCliLoginResponse>((data) => {
    const session = findLoginSession(data, request.userCode);

    if (!session || isExpired(session)) {
      return { status: "expired" };
    }

    if (session.status === "pending") {
      return { status: "pending" };
    }

    if (session.status === "consumed") {
      return { status: "expired" };
    }

    const identity = session.identity ?? {
      user: demoUser,
      organization: demoOrganization
    };

    data.cliTokens.push({
      id: randomUUID(),
      orgId: identity.organization.id,
      userId: identity.user.id,
      tokenHash: hashSecret(token),
      label: session.label,
      identity,
      createdAt: new Date().toISOString(),
      lastUsedAt: null
    });
    session.status = "consumed";

    return {
      status: "complete",
      token,
      user: identity.user,
      organization: identity.organization
    };
  });
}

export async function verifyCliToken(
  token: string
): Promise<AuthIdentity | null> {
  const tokenHash = hashSecret(token);

  return updateAuthData<AuthIdentity | null>((data) => {
    const record = data.cliTokens.find((item) => item.tokenHash === tokenHash);

    if (!record) {
      return null;
    }

    record.lastUsedAt = new Date().toISOString();

    return (
      record.identity ?? loadIdentityFromData(data, record.userId, record.orgId)
    );
  });
}

export async function upsertIdentity(
  request: UpsertIdentityRequest
): Promise<AuthIdentity> {
  return updateAuthData((data) => upsertIdentityInData(data, request));
}

export async function loadIdentityByIds(
  userId: string,
  orgId: string
): Promise<AuthIdentity | null> {
  const data = await readAuthData();
  return loadIdentityFromData(data, userId, orgId);
}

async function readAuthData(): Promise<AuthData> {
  const document = await getDocumentStore().read<AuthData>(AUTH_KEY);
  return document?.value ?? seedAuthData();
}

/**
 * Read, apply, write as one step. `apply` mutates the document in place and
 * returns whatever the caller needs, so the read-modify-write pattern this
 * file already used carries over unchanged.
 */
async function updateAuthData<T>(apply: (data: AuthData) => T): Promise<T> {
  let result!: T;

  await getDocumentStore().mutate<AuthData>(AUTH_KEY, (current) => {
    const data = current ?? seedAuthData();
    result = apply(data);
    return data;
  });

  return result;
}

function seedAuthData(): AuthData {
  return {
    loginSessions: [],
    cliTokens: [],
    organizations: [demoOrganization],
    users: [demoUser]
  };
}

function findLoginSession(
  data: AuthData,
  userCode: string
): CliLoginSession | undefined {
  const userCodeHash = hashSecret(normalizeUserCode(userCode));
  return data.loginSessions.find((session) => session.userCodeHash === userCodeHash);
}

function isExpired(session: CliLoginSession): boolean {
  return Date.parse(session.expiresAt) <= Date.now();
}

function upsertIdentityInData(
  data: AuthData,
  request: UpsertIdentityRequest
): AuthIdentity {
  const email = request.email.trim().toLowerCase();
  const domain = email.split("@").pop();
  const allowedDomains = getAllowedEmailDomains();

  if (!domain || !allowedDomains.includes(domain)) {
    throw new Response("Email domain is not allowed", { status: 403 });
  }

  data.organizations ??= [demoOrganization];
  data.users ??= [demoUser];

  let organization = data.organizations.find((item) =>
    item.allowedDomains.includes(domain)
  );
  const now = new Date().toISOString();

  if (!organization) {
    organization = {
      id: randomUUID(),
      primaryDomain: domain,
      allowedDomains,
      name: domain,
      createdAt: now
    };
    data.organizations.push(organization);
  } else {
    organization.allowedDomains = allowedDomains;
  }

  let user = data.users.find(
    (item) => item.orgId === organization.id && item.email === email
  );

  if (!user) {
    user = {
      id: randomUUID(),
      orgId: organization.id,
      email,
      name: request.name,
      avatarUrl: request.avatarUrl,
      createdAt: now
    };
    data.users.push(user);
  } else {
    user.name = request.name;
    user.avatarUrl = request.avatarUrl;
  }

  return { user, organization };
}

function ensureIdentity(data: AuthData, identity: AuthIdentity): void {
  data.organizations ??= [demoOrganization];
  data.users ??= [demoUser];

  if (!data.organizations.some((item) => item.id === identity.organization.id)) {
    data.organizations.push(identity.organization);
  }

  if (!data.users.some((item) => item.id === identity.user.id)) {
    data.users.push(identity.user);
  }
}

function loadIdentityFromData(
  data: AuthData,
  userId: string,
  orgId: string
): AuthIdentity | null {
  const user =
    data.users?.find((item) => item.id === userId) ??
    (userId === demoUser.id ? demoUser : null);
  const organization =
    data.organizations?.find((item) => item.id === orgId) ??
    (orgId === demoOrganization.id ? demoOrganization : null);

  if (!user || !organization) {
    return null;
  }

  return { user, organization };
}


