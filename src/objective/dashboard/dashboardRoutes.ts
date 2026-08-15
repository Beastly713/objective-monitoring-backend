import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

interface DashboardAsset {
  contentType: string;
  path: string;
  cacheControl: string;
}

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(moduleDirectory, "../../..");

const DASHBOARD_ASSETS = new Map<string, DashboardAsset>([
  [
    "/clinician/objective",
    {
      contentType: "text/html; charset=utf-8",
      path: path.join(repositoryRoot, "public/objective/index.html"),
      cacheControl: "no-cache",
    },
  ],
  [
    "/clinician/objective/",
    {
      contentType: "text/html; charset=utf-8",
      path: path.join(repositoryRoot, "public/objective/index.html"),
      cacheControl: "no-cache",
    },
  ],
  [
    "/objective-assets/objective.css",
    {
      contentType: "text/css; charset=utf-8",
      path: path.join(repositoryRoot, "public/objective/objective.css"),
      cacheControl: "no-cache",
    },
  ],
  [
    "/objective-assets/objective.js",
    {
      contentType: "text/javascript; charset=utf-8",
      path: path.join(repositoryRoot, "public/objective/objective.js"),
      cacheControl: "no-cache",
    },
  ],
  [
    "/objective-assets/uPlot.iife.min.js",
    {
      contentType: "text/javascript; charset=utf-8",
      path: path.join(repositoryRoot, "node_modules/uplot/dist/uPlot.iife.min.js"),
      cacheControl: "public, max-age=86400",
    },
  ],
  [
    "/objective-assets/uPlot.min.css",
    {
      contentType: "text/css; charset=utf-8",
      path: path.join(repositoryRoot, "node_modules/uplot/dist/uPlot.min.css"),
      cacheControl: "public, max-age=86400",
    },
  ],
]);

export async function handleObjectiveDashboardRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<boolean> {
  if (request.method !== "GET") {
    return false;
  }

  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  const asset = DASHBOARD_ASSETS.get(pathname);
  if (asset === undefined) {
    return false;
  }

  const contents = await readFile(asset.path);
  response.writeHead(200, {
    "cache-control": asset.cacheControl,
    "content-length": contents.byteLength,
    "content-type": asset.contentType,
    "x-content-type-options": "nosniff",
  });
  response.end(contents);
  return true;
}
