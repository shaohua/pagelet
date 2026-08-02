/**
 * Auth surface used by routes. One implementation, over the same document
 * store as everything else.
 */
import type { Organization, User } from "@pagelet/shared";

export type AuthIdentity = {
  user: User;
  organization: Organization;
};

export type UpsertIdentityRequest = {
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export {
  confirmCliLogin,
  hashSecret,
  loadIdentityByIds,
  pollCliLogin,
  startCliLogin,
  upsertIdentity,
  verifyCliToken
} from "./auth-store";
