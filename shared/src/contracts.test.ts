import { describe, expect, it } from "vitest";
import {
  commentThreadSchema,
  getPublishConfigResponseSchema,
  organizationSchema,
  pageletSchema,
  pageletVersionSchema,
  userSchema
} from "./schemas.js";
import {
  demoCommentThreads,
  demoOrganization,
  demoPagelet,
  demoPublishConfig,
  demoUser,
  demoVersions
} from "./fixtures.js";

describe("shared fixtures", () => {
  it("match shared schemas", () => {
    expect(() => organizationSchema.parse(demoOrganization)).not.toThrow();
    expect(() => userSchema.parse(demoUser)).not.toThrow();
    expect(() => pageletSchema.parse(demoPagelet)).not.toThrow();
    expect(() =>
      demoVersions.map((version) => pageletVersionSchema.parse(version))
    ).not.toThrow();
    expect(() =>
      demoCommentThreads.map((thread) => commentThreadSchema.parse(thread))
    ).not.toThrow();
    expect(() =>
      getPublishConfigResponseSchema.parse(demoPublishConfig)
    ).not.toThrow();
  });
});
