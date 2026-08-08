export async function serve(configPath: string): Promise<void> {
  const { bootstrap } = await import("../../../bootstrap.js");
  await bootstrap(configPath);
}
