/** Normalized authenticated principal used by Support domain services. */
export interface SupportActor {
  userId: string;
  handle: string;
  roles: string[];
  scopes: string[];
  isMachine: boolean;
  isSupportTeam: boolean;
}

/** Express request extension populated after JWT authentication. */
export interface SupportAuthenticatedRequest {
  authUser?: Record<string, unknown>;
  supportActor?: SupportActor;
}
