import type {
  CommentThread,
  GetPublishConfigResponse,
  Organization,
  Pagelet,
  PageletVersion,
  User
} from "./schemas.js";

const now = "2026-06-20T12:00:00.000Z";
const versionOneId = "44444444-4444-4444-8444-444444444441";
const versionTwoId = "44444444-4444-4444-8444-444444444442";

export const demoOrganization: Organization = {
  id: "11111111-1111-4111-8111-111111111111",
  primaryDomain: "example.com",
  allowedDomains: ["example.com"],
  name: "Example Company",
  createdAt: now
};

export const demoUser: User = {
  id: "22222222-2222-4222-8222-222222222222",
  orgId: demoOrganization.id,
  email: "reviewer@example.com",
  name: "Reviewer",
  avatarUrl: null,
  createdAt: now
};

export const demoPagelet: Pagelet = {
  id: "33333333-3333-4333-8333-333333333333",
  orgId: demoOrganization.id,
  ownerUserId: demoUser.id,
  shareId: "pl_demo123",
  slug: "q2-revenue-dashboard",
  title: "Q2 Revenue Dashboard",
  visibility: "domain_private",
  latestVersionId: versionTwoId,
  versionCount: 2,
  createdAt: now,
  updatedAt: now
};

export const demoVersions: PageletVersion[] = [
  {
    id: versionOneId,
    pageletId: demoPagelet.id,
    versionNumber: 1,
    parentVersionId: null,
    gcsHtmlObject:
      "orgs/11111111-1111-4111-8111-111111111111/pagelets/33333333-3333-4333-8333-333333333333/versions/44444444-4444-4444-8444-444444444441/report.html",
    gcsJournalObject:
      "orgs/11111111-1111-4111-8111-111111111111/pagelets/33333333-3333-4333-8333-333333333333/versions/44444444-4444-4444-8444-444444444441/pagelet-journal.md",
    assetManifest: [],
    sha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sizeBytes: 2048,
    message: "Initial dashboard",
    createdByUserId: demoUser.id,
    createdAt: now
  },
  {
    id: versionTwoId,
    pageletId: demoPagelet.id,
    versionNumber: 2,
    parentVersionId: versionOneId,
    gcsHtmlObject:
      "orgs/11111111-1111-4111-8111-111111111111/pagelets/33333333-3333-4333-8333-333333333333/versions/44444444-4444-4444-8444-444444444442/report.html",
    gcsJournalObject:
      "orgs/11111111-1111-4111-8111-111111111111/pagelets/33333333-3333-4333-8333-333333333333/versions/44444444-4444-4444-8444-444444444442/pagelet-journal.md",
    assetManifest: [],
    sha256:
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    sizeBytes: 3072,
    message: "Address review comments",
    createdByUserId: demoUser.id,
    createdAt: now
  }
];

export const demoCommentThreads: CommentThread[] = [
  {
    id: "55555555-5555-4555-8555-555555555555",
    pageletId: demoPagelet.id,
    versionId: versionOneId,
    authorUserId: demoUser.id,
    kind: "change_request",
    priority: "blocking",
    status: "open",
    assigneeUserId: demoUser.id,
    anchor: {
      xPct: 42.1,
      yPct: 31.8,
      documentWidth: 1440,
      documentHeight: 1200,
      viewportWidth: 1280,
      viewportHeight: 800,
      scrollX: 0,
      scrollY: 0,
      selector: "h2",
      textFingerprint: "ARR by Month"
    },
    messages: [
      {
        id: "66666666-6666-4666-8666-666666666666",
        threadId: "55555555-5555-4555-8555-555555555555",
        authorUserId: demoUser.id,
        bodyMarkdown: "Can we break this data by region?",
        mentionedUserIds: [],
        createdAt: now,
        updatedAt: now,
        editedAt: null
      }
    ],
    resolvedByUserId: null,
    resolvedAt: null,
    createdAt: now,
    updatedAt: now
  }
];

export const demoPublishConfig: GetPublishConfigResponse = {
  maxUploadBytes: 25 * 1024 * 1024,
  allowedExternalOrigins: [
    "https://cdn.jsdelivr.net",
    "https://fonts.googleapis.com",
    "https://fonts.gstatic.com"
  ]
};
