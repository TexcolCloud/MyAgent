import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { startTestApp } from "../helpers/start-test-app.js";

describe("HTTP Automation Surface v1", () => {
  it("documents every registered /v1 route", async () => {
    const document = await readFile("docs/operations/http-automation-v1.md", "utf8");
    const app = await startTestApp();
    try {
      await app.app.ready();
      const routes = routeInventory(app.app.printRoutes({ commonPrefix: false }));

      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) expect(document).toContain(`| ${route} |`);
    } finally {
      await app.close();
    }
  });
});

function routeInventory(tree: string): readonly string[] {
  const currentPath: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split("\n")) {
    const depth = line.search(/\S/u);
    const path = line.match(/(?:^|\s)(\/[^\s(]+)/u)?.[1];
    const methods = line.match(/\(([^)]+)\)/u)?.[1]
      ?.split(",")
      .map((method) => method.trim()) ?? [];
    if (path !== undefined) {
      currentPath[Math.floor(depth / 4)] = path;
      currentPath.length = Math.floor(depth / 4) + 1;
    }
    const url = currentPath.join("").replaceAll("//", "/");
    if (!url.startsWith("/v1/")) continue;
    for (const method of methods) {
      if (["GET", "POST", "PUT", "DELETE"].includes(method)) routes.push(`${method} ${url}`);
    }
  }
  return [...new Set(routes)].sort();
}
