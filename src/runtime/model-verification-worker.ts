import type { VerifyModelService } from "../application/verify-model.js";
import { DomainError } from "../domain/errors.js";
import type { ModelVerificationId } from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { ModelRegistryStore } from "../ports/model-registry-store.js";

export interface ModelVerificationWorkerOptions {
  readonly registry: Pick<
    ModelRegistryStore,
    "claimVerification" | "renewVerificationLease"
  >;
  readonly verify: Pick<VerifyModelService, "failClaimed" | "runClaimed">;
  readonly clock: Clock;
  readonly workerId: string;
  readonly concurrency?: number;
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly idleDelayMs?: number;
  readonly onUnexpectedVerificationError?: (
    error: unknown,
    verificationId: ModelVerificationId,
  ) => void;
  readonly onFatalError?: (error: unknown) => void;
}

export class ModelVerificationWorker {
  private readonly concurrency: number;
  private readonly leaseDurationMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly idleDelayMs: number;
  private readonly active = new Map<ModelVerificationId, AbortController>();
  private loops: Promise<void>[] = [];
  private fatalFailures: unknown[] = [];
  private running = false;

  constructor(private readonly options: ModelVerificationWorkerOptions) {
    this.concurrency = positiveInteger(options.concurrency ?? 1, "concurrency");
    this.leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? 30_000,
      "lease_duration",
    );
    this.heartbeatIntervalMs = positiveInteger(
      options.heartbeatIntervalMs ?? 10_000,
      "heartbeat_interval",
    );
    this.idleDelayMs = positiveInteger(options.idleDelayMs ?? 50, "idle_delay");
    if (this.heartbeatIntervalMs >= this.leaseDurationMs) {
      throw new Error("invalid_verification_heartbeat");
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.fatalFailures = [];
    this.loops = Array.from({ length: this.concurrency }, (_, index) =>
      this.claimLoop(index).catch((error: unknown) => {
        this.fatalFailures.push(error);
        this.running = false;
        this.abortActive(error);
        try {
          this.options.onFatalError?.(error);
        } catch (reportingError) {
          this.fatalFailures.push(reportingError);
        }
      })
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abortActive(new Error("verification_worker_stopped"));
    await Promise.all(this.loops);
    this.loops = [];
    const failure = this.fatalFailures[0];
    this.fatalFailures = [];
    if (failure !== undefined) throw failure;
  }

  private async claimLoop(index: number): Promise<void> {
    const leaseOwner = `${this.options.workerId}:${index}`;
    let busyDelayMs = 50;
    while (this.running) {
      let verification;
      try {
        const now = this.options.clock.now();
        verification = this.options.registry.claimVerification({
          leaseOwner,
          now,
          leaseUntil: new Date(now.getTime() + this.leaseDurationMs),
        });
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        await this.options.clock.sleep(busyDelayMs);
        busyDelayMs = Math.min(1_000, busyDelayMs * 2);
        continue;
      }
      busyDelayMs = 50;
      if (verification === null) {
        await this.options.clock.sleep(this.idleDelayMs);
        continue;
      }

      const controller = new AbortController();
      let heartbeatFailure: unknown;
      const heartbeat = setInterval(() => {
        try {
          const heartbeatNow = this.options.clock.now();
          const renewed = this.options.registry.renewVerificationLease({
            verificationId: verification.verificationId,
            leaseOwner,
            now: heartbeatNow,
            leaseUntil: new Date(heartbeatNow.getTime() + this.leaseDurationMs),
          });
          if (!renewed) throw new DomainError("verification_lease_lost");
        } catch (error) {
          heartbeatFailure = error;
          controller.abort(error);
        }
      }, this.heartbeatIntervalMs);
      heartbeat.unref?.();
      this.active.set(verification.verificationId, controller);
      try {
        await this.options.verify.runClaimed(verification, controller.signal);
        if (heartbeatFailure !== undefined) throw heartbeatFailure;
      } catch (error) {
        const cause = heartbeatFailure ?? error;
        if (isSqliteUnavailable(cause)) throw cause;
        if (isSqliteBusy(cause)) {
          await this.options.clock.sleep(busyDelayMs);
          busyDelayMs = Math.min(1_000, busyDelayMs * 2);
          continue;
        }
        if (
          !controller.signal.aborted &&
          !isVerificationLeaseLost(cause)
        ) {
          try {
            this.options.verify.failClaimed(verification);
          } catch (completionError) {
            if (isVerificationLeaseLost(completionError)) continue;
            if (isSqliteBusy(completionError)) {
              await this.options.clock.sleep(busyDelayMs);
              busyDelayMs = Math.min(1_000, busyDelayMs * 2);
              continue;
            }
            throw completionError;
          }
          this.options.onUnexpectedVerificationError?.(
            cause,
            verification.verificationId,
          );
        }
      } finally {
        clearInterval(heartbeat);
        this.active.delete(verification.verificationId);
      }
    }
  }

  private abortActive(reason: unknown): void {
    for (const controller of this.active.values()) controller.abort(reason);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid_verification_worker_${name}`);
  }
  return value;
}

function isVerificationLeaseLost(error: unknown): boolean {
  return error instanceof Error &&
    (error as Error & { code?: unknown }).code === "verification_lease_lost";
}

function isSqliteUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const details = error as Error & { code?: unknown; errcode?: unknown };
  if (details.errcode === 5 || /database is locked|database is busy/i.test(error.message)) {
    return false;
  }
  return (
    isSqliteUnavailableCode(details.code) ||
    /database(?: connection)? (?:is )?(?:closed|not open)|disk i\/o|not a database|database disk image is malformed|unable to open database/i
      .test(error.message)
  );
}

function isSqliteUnavailableCode(code: unknown): boolean {
  if (typeof code !== "string") return false;
  return code === "SQLITE_MISUSE" ||
    code === "SQLITE_NOTADB" ||
    code === "SQLITE_IOERR" ||
    code.startsWith("SQLITE_IOERR_") ||
    code === "SQLITE_CORRUPT" ||
    code.startsWith("SQLITE_CORRUPT_") ||
    code === "SQLITE_CANTOPEN" ||
    code.startsWith("SQLITE_CANTOPEN_");
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && (
    (error as Error & { errcode?: unknown }).errcode === 5 ||
    /database is locked|database is busy/i.test(error.message)
  );
}
