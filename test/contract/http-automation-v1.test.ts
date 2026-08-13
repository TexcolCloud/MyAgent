import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { startTestApp } from "../helpers/start-test-app.js";

describe("HTTP Automation Surface v1", () => {
  it("parses exact Route cells and rejects phantom documentation routes", () => {
    const document = [
      "| Route | Authority | Automation purpose |",
      "| --- | --- | --- |",
      "| GET /v1/runs | Run | List Runs. |",
      "| POST /v1/runs | Run | Create a Run. |",
      "| GET /v1/phantom | Run | Stale route. |",
    ].join("\n");

    expect(automationDocumentRoutes(document)).toEqual([
      "GET /v1/phantom",
      "GET /v1/runs",
      "POST /v1/runs",
    ]);
    expect(automationDocumentRoutes(document)).not.toEqual([
      "GET /v1/runs",
      "POST /v1/runs",
    ]);
  });

  it("documents every registered /v1 route", async () => {
    const document = await readFile("docs/operations/http-automation-v1.md", "utf8");
    const app = await startTestApp({ includeOptionalRoutes: true });
    try {
      await app.app.ready();
      const routes = routeInventory(app.app.printRoutes({ commonPrefix: false }));

      expect(routes.length).toBeGreaterThan(0);
      expect(routes).toEqual(expect.arrayContaining([
        "POST /v1/admin/agents",
        "GET /v1/admin/diagnostics",
      ]));
      expect(automationDocumentRoutes(document)).toEqual(routes);
    } finally {
      await app.close();
    }
  });
});

function routeInventory(tree: string): readonly string[] {
  const currentPath: string[] = [];
  const routes: string[] = [];
  for (const line of tree.split("\n")) {
    const branch = Math.max(line.indexOf("├"), line.indexOf("└"));
    if (branch < 0) continue;
    const depth = branch / 4;
    const path = line.match(/[├└]── (\/[^\s(]+)/u)?.[1];
    const methods = line.match(/\(([^)]+)\)/u)?.[1]
      ?.split(",")
      .map((method) => method.trim()) ?? [];
    if (path !== undefined) {
      currentPath[depth] = path;
      currentPath.length = depth + 1;
    }
    const url = currentPath.join("").replaceAll("//", "/");
    if (!url.startsWith("/v1/")) continue;
    for (const method of methods) {
      if (["GET", "POST", "PUT", "DELETE"].includes(method)) routes.push(`${method} ${url}`);
    }
  }
  return [...new Set(routes)].sort();
}

function automationDocumentRoutes(document: string): readonly string[] {
  const routes = document.split("\n")
    .flatMap((line) => {
      const cells = line.split("|").map((cell) => cell.trim());
      const route = cells[1];
      return route !== undefined && /^(?:GET|POST|PUT|DELETE) \/v1\//u.test(route)
        ? [route]
        : [];
    });
  return [...new Set(routes)].sort();
}
