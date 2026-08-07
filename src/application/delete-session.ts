import type { SessionId } from "../domain/ids.js";

export interface SessionDeletionStore {
  deleteIfIdle(sessionId: SessionId): void;
}

export class DeleteSessionService {
  constructor(private readonly sessions: SessionDeletionStore) {}

  execute(sessionId: SessionId): void {
    this.sessions.deleteIfIdle(sessionId);
  }
}
