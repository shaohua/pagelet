import { generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createLocalJWKSet, exportJWK } from "jose";
import { verifyIapRequest } from "./iap";

const audience = "/projects/123/locations/us-central1/services/pagelet";

describe("IAP request verification", () => {
  it("accepts a signed assertion and normalizes its identity", async () => {
    const { request, keySet } = await signedRequest({
      sub: "accounts.google.com:12345",
      email: "Reviewer@Example.com",
      hd: "Example.com"
    });

    await expect(
      verifyIapRequest(request, { audience, keySet })
    ).resolves.toEqual({
      subject: "accounts.google.com:12345",
      email: "reviewer@example.com",
      hostedDomain: "example.com"
    });
  });

  it("rejects missing assertions and the wrong audience", async () => {
    await expectResponseStatus(
      () => verifyIapRequest(new Request("https://pagelet.test"), { audience }),
      401
    );
    const { request, keySet } = await signedRequest({
      sub: "12345",
      email: "reviewer@example.com"
    });

    await expectResponseStatus(
      () => verifyIapRequest(request, { audience: "wrong", keySet }),
      401
    );
  });
});

async function signedRequest(claims: Record<string, string>): Promise<{
  request: Request;
  keySet: ReturnType<typeof createLocalJWKSet>;
}> {
  const { privateKey, publicKey } = await generateKeyPair("ES256");
  const kid = "test-key";
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "ES256", kid })
    .setAudience(audience)
    .setIssuer("https://cloud.google.com/iap")
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(privateKey);
  const jwk = await exportJWK(publicKey);
  const keySet = createLocalJWKSet({ keys: [{ ...jwk, alg: "ES256", kid }] });

  return {
    keySet,
    request: new Request("https://pagelet.test", {
      headers: { "x-goog-iap-jwt-assertion": token }
    })
  };
}

async function expectResponseStatus(
  action: () => unknown | Promise<unknown>,
  status: number
): Promise<void> {
  try {
    await action();
    throw new Error(`Expected Response ${status}`);
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(status);
  }
}
