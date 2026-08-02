/**
 * The HTTP handlers.
 *
 * Each one takes the web-standard Request plus the path parameters the router
 * matched, and returns a Response. Nothing here knows which router called it.
 */
import {
  createCommentReplyRequestSchema,
  createCommentThreadRequestSchema,
  createPageletDraftRequestSchema,
  createVersionDraftRequestSchema,
  finalizeVersionRequestSchema,
  pollCliLoginRequestSchema,
  startCliLoginRequestSchema,
  updateCommentThreadRequestSchema,
  type CreateCommentReplyRequest,
  type CreateCommentThreadRequest,
  type CreatePageletDraftRequest,
  type CreateVersionDraftRequest,
  type FinalizeVersionRequest,
  type PollCliLoginRequest,
  type StartCliLoginRequest,
  type UpdateCommentThreadRequest
} from "@pagelet/shared";
import { reportContentSecurityPolicy } from "../security/render-policy";
import {
  assertAllowedEmailDomainForEmail,
  requireCliAuth,
  requirePageletAccess
} from "./auth";
import {
  confirmCliLogin,
  pollCliLogin,
  startCliLogin,
  upsertIdentity
} from "./auth-repository";
import {
  getAllowedExternalOrigins,
  getPublicAppBaseUrl
} from "./config";
import {
  buildGoogleAuthorizationUrl,
  createOAuthState,
  exchangeGoogleCode,
  fetchGoogleProfile,
  verifyOAuthState
} from "./google-oauth";
import { injectRenderBridge } from "./render-bridge";
import {
  createCommentReply,
  createCommentThread,
  createPageletDraft,
  createVersionDraft,
  exportFeedbackMarkdown,
  finalizeVersion,
  getPagelet,
  getPublishConfig,
  listComments,
  putDraftUpload,
  readVersionAsset,
  readVersionHtml,
  updateCommentThread
} from "./repository";
import {
  clearOAuthStateCookie,
  clearSessionCookie,
  createOAuthStateCookie,
  createSessionCookie,
  createSessionPayload,
  readOAuthStateCookie
} from "./session";

export async function handleGetPublishConfig(
  request: Request
): Promise<Response> {
  await requireCliAuth(request);
  return Response.json(await getPublishConfig());
}

export async function handleCreatePagelet(request: Request): Promise<Response> {
  await requireCliAuth(request);
  const body = createPageletDraftRequestSchema.parse(
    (await request.json()) as CreatePageletDraftRequest
  );
  return Response.json(
    await createPageletDraft(body, getPublicAppBaseUrl(request.url))
  );
}

export async function handleGetPagelet(
  request: Request,
  params: Readonly<{ shareId: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const url = new URL(request.url);
  const version = url.searchParams.get("version");
  return Response.json(
    await getPagelet(
      params.shareId,
      version ? Number.parseInt(version, 10) : undefined
    )
  );
}

export async function handleListComments(
  request: Request,
  params: Readonly<{ shareId: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const url = new URL(request.url);
  const version = url.searchParams.get("version");
  return Response.json(
    await listComments(
      params.shareId,
      version ? Number.parseInt(version, 10) : undefined
    )
  );
}

export async function handleCreateComment(
  request: Request,
  params: Readonly<{ shareId: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const body = createCommentThreadRequestSchema.parse(
    (await request.json()) as CreateCommentThreadRequest
  );
  return Response.json(await createCommentThread(params.shareId, body));
}

export async function handleExportFeedback(
  request: Request,
  params: Readonly<{ shareId: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const url = new URL(request.url);
  const version = url.searchParams.get("version");
  const status = url.searchParams.get("status");
  const markdown = await exportFeedbackMarkdown({
    shareId: params.shareId,
    versionNumber: version ? Number.parseInt(version, 10) : undefined,
    status: status === "resolved" || status === "all" ? status : "open"
  });

  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8"
    }
  });
}

export async function handleCreateVersion(
  request: Request,
  params: Readonly<{ shareId: string }>
): Promise<Response> {
  await requireCliAuth(request);
  const body = createVersionDraftRequestSchema.parse(
    (await request.json()) as CreateVersionDraftRequest
  );
  return Response.json(
    await createVersionDraft(
      params.shareId,
      body,
      getPublicAppBaseUrl(request.url)
    )
  );
}

export async function handleFinalizeVersion(
  request: Request,
  params: Readonly<{ shareId: string; draftId: string }>
): Promise<Response> {
  await requireCliAuth(request);
  const body = finalizeVersionRequestSchema.parse(
    (await request.json()) as FinalizeVersionRequest
  );
  return Response.json(
    await finalizeVersion(
      params.shareId,
      params.draftId,
      body,
      getPublicAppBaseUrl(request.url)
    )
  );
}

export async function handleUploadDraftFile(
  request: Request,
  params: Readonly<{ draftId: string; fileIndex: string }>
): Promise<Response> {
  await requireCliAuth(request);
  await putDraftUpload(
    params.draftId,
    Number.parseInt(params.fileIndex, 10),
    await request.arrayBuffer()
  );
  return Response.json({ ok: true });
}

export async function handleStartCliLogin(request: Request): Promise<Response> {
  const body = startCliLoginRequestSchema.parse(
    (await request.json()) as StartCliLoginRequest
  );
  return Response.json(
    await startCliLogin(body, getPublicAppBaseUrl(request.url))
  );
}

export async function handlePollCliLogin(request: Request): Promise<Response> {
  const body = pollCliLoginRequestSchema.parse(
    (await request.json()) as PollCliLoginRequest
  );
  return Response.json(await pollCliLogin(body));
}

export async function handleConfirmCliLogin(
  request: Request
): Promise<Response> {
  const session = await requirePageletAccess(request);
  const body = (await request.json()) as { userCode?: string };

  if (!body.userCode) {
    throw new Response("Missing user code", { status: 400 });
  }

  await confirmCliLogin(body.userCode, {
    user: session.user,
    organization: session.organization
  });
  return Response.json({ ok: true });
}

export async function handleUpdateCommentThread(
  request: Request,
  params: Readonly<{ threadId: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const body = updateCommentThreadRequestSchema.parse(
    (await request.json()) as UpdateCommentThreadRequest
  );
  return Response.json(await updateCommentThread(params.threadId, body));
}

export async function handleCreateCommentReply(
  request: Request,
  params: Readonly<{ threadId: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const body = createCommentReplyRequestSchema.parse(
    (await request.json()) as CreateCommentReplyRequest
  );
  return Response.json(await createCommentReply(params.threadId, body));
}

export async function handleGoogleSignIn(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const appBaseUrl = getPublicAppBaseUrl(request.url);
  const state = createOAuthState({
    appBaseUrl,
    returnTo: requestUrl.searchParams.get("returnTo")
  });
  const headers = new Headers({
    Location: buildGoogleAuthorizationUrl({ appBaseUrl, state })
  });

  headers.append(
    "Set-Cookie",
    createOAuthStateCookie(state, {
      secure: new URL(appBaseUrl).protocol === "https:"
    })
  );

  return new Response(null, {
    status: 302,
    headers
  });
}

export async function handleGoogleCallback(
  request: Request
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const state = requestUrl.searchParams.get("state");
  const cookieState = readOAuthStateCookie(request);

  if (!code || !state || !cookieState || state !== cookieState) {
    throw new Response("Invalid Google OAuth state", { status: 400 });
  }

  const verifiedState = verifyOAuthState(state);

  if (!verifiedState) {
    throw new Response("Invalid Google OAuth state", { status: 400 });
  }

  const appBaseUrl = getPublicAppBaseUrl(request.url);
  const accessToken = await exchangeGoogleCode(code, appBaseUrl);
  const profile = await fetchGoogleProfile(accessToken);
  assertAllowedEmailDomainForEmail(profile.email);
  const identity = await upsertIdentity(profile);
  const headers = new Headers({
    Location: verifiedState.returnTo
  });

  headers.append(
    "Set-Cookie",
    createSessionCookie(
      createSessionPayload({
        userId: identity.user.id,
        orgId: identity.organization.id,
        email: identity.user.email
      }),
      {
        secure: new URL(appBaseUrl).protocol === "https:"
      }
    )
  );
  headers.append("Set-Cookie", clearOAuthStateCookie());

  return new Response(null, {
    status: 302,
    headers
  });
}

export async function handleLogout(): Promise<Response> {
  return new Response(null, {
    status: 302,
    headers: {
      Location: "/",
      "Set-Cookie": clearSessionCookie()
    }
  });
}

export async function handleRenderVersion(
  request: Request,
  params: Readonly<{ shareId: string; versionNumber: string }>
): Promise<Response> {
  await requirePageletAccess(request);
  const { html, version } = await readVersionHtml(
    params.shareId,
    params.versionNumber
  );
  const htmlWithBase = injectBaseHref(
    html,
    `/r/${params.shareId}/${version.versionNumber}/`
  );
  const htmlWithBridge = injectRenderBridge(htmlWithBase);

  return new Response(htmlWithBridge, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": reportContentSecurityPolicy(
        getAllowedExternalOrigins()
      )
    }
  });
}

export async function handleRenderVersionAsset(
  request: Request,
  params: Readonly<{
    shareId: string;
    versionNumber: string;
    assetPath: string;
  }>
): Promise<Response> {
  await requirePageletAccess(request);
  if (!params.assetPath) {
    throw new Response("Asset not found", { status: 404 });
  }

  const { bytes, contentType } = await readVersionAsset(
    params.shareId,
    params.versionNumber,
    params.assetPath
  );

  return new Response(new Uint8Array(bytes), {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=300"
    }
  });
}

function injectBaseHref(html: string, href: string): string {
  const base = `<base href="${href}">`;

  if (/<base\b/i.test(html)) {
    return html.replace(/<base\b[^>]*>/i, base);
  }

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (match) => `${match}${base}`);
  }

  return `${base}${html}`;
}
