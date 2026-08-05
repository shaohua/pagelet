import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey
} from "jose";

export type IapIdentity = {
  subject: string;
  email: string;
  hostedDomain: string | null;
};

const issuer = "https://cloud.google.com/iap";
const publicKeys = createRemoteJWKSet(
  new URL("https://www.gstatic.com/iap/verify/public_key-jwk")
);

export async function verifyIapRequest(
  request: Request,
  options: Readonly<{
    audience?: string;
    keySet?: JWTVerifyGetKey;
  }> = {}
): Promise<IapIdentity> {
  const assertion = request.headers.get("x-goog-iap-jwt-assertion");

  if (!assertion) {
    throw new Response("IAP authentication required", { status: 401 });
  }

  const audience = options.audience ?? configuredAudience();
  let payload: JWTPayload;

  try {
    ({ payload } = await jwtVerify(assertion, options.keySet ?? publicKeys, {
      algorithms: ["ES256"],
      audience,
      issuer
    }));
  } catch {
    throw new Response("Invalid IAP assertion", { status: 401 });
  }

  const subject = payload.sub;
  const rawEmail = payload.email;

  if (!subject || typeof rawEmail !== "string") {
    throw new Response("IAP assertion is missing identity claims", {
      status: 401
    });
  }

  return {
    subject,
    email: normalizeNamespacedValue(rawEmail).toLowerCase(),
    hostedDomain:
      typeof payload.hd === "string"
        ? normalizeNamespacedValue(payload.hd).toLowerCase()
        : null
  };
}

function configuredAudience(): string {
  const audience = process.env.PAGELET_IAP_AUDIENCE?.trim();

  if (!audience) {
    throw new Error("PAGELET_IAP_AUDIENCE is required for IAP authentication");
  }

  return audience;
}

function normalizeNamespacedValue(value: string): string {
  return value.startsWith("accounts.google.com:")
    ? value.slice("accounts.google.com:".length)
    : value;
}
