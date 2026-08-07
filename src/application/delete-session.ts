import type { SessionId } from "../domain/ids.js";
import { DomainError } from "../domain/errors.js";
import type { SessionStore } from "../ports/session-store.js";

export interface SessionDeletionStore extends Pick<SessionStore, "delete"> {
  hasRunningRun(sessionId: SessionId): boolean;
}

export class DeleteSessionService {
  constructor(private readonly sessions: SessionDeletionStore) {}

  execute(sessionId: SessionId): void {
    if (this.sessions.hasRunningRun(sessionId)) throw new DomainError("session_has_running_run");
    this.sessions.delete(sessionId);
  }
}
