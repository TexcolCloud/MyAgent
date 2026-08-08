import type { CatalogSnapshot } from "../config/catalog-loader.js";
import type { CatalogService } from "../config/catalog-service.js";
import type { Clock } from "../ports/clock.js";

export interface BackupManifest {
  schemaVersion: 1;
  createdAt: string;
  database: "kernel.db";
  files: string[];
  sha256: Record<string, string>;
  activeRevisionIds: string[];
}

export interface BackupSummary {
  destination: string;
  database: "kernel.db";
  fileCount: number;
  activeRevisionIds: string[];
}

export interface BackupWriter {
  create(input: {
    destination: string;
    catalog: CatalogSnapshot;
    occurredAt: Date;
  }): Promise<BackupSummary>;
}

export class CreateBackupService {
  constructor(
    private readonly backups: BackupWriter,
    private readonly catalog: Pick<CatalogService, "current">,
    private readonly clock: Pick<Clock, "now">,
  ) {}

  execute(input: { destination: string }): Promise<BackupSummary> {
    return this.backups.create({
      destination: input.destination,
      catalog: this.catalog.current(),
      occurredAt: this.clock.now(),
    });
  }
}
