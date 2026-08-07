export function assertSupportedRuntime(
  version: NodeJS.ProcessVersions = process.versions,
): void {
  const major = Number.parseInt(version.node.split(".")[0] ?? "", 10);
  if (major !== 24) {
    throw new Error(`MyAgent requires Node.js 24 LTS; received ${version.node}`);
  }
}
