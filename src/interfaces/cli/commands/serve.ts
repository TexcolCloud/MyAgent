import { bootstrap } from "../../../bootstrap.js";
export async function serve(configPath: string): Promise<void> { await bootstrap(configPath); }
