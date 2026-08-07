import { cpSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

const source = fileURLToPath(
  new URL("../src/adapters/sqlite/migrations", import.meta.url),
);
const destination = fileURLToPath(
  new URL("../dist/src/adapters/sqlite/migrations", import.meta.url),
);

cpSync(source, destination, { recursive: true, force: true });
