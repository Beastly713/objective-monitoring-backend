import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";

import { handleObjectiveDashboardRequest } from "./dashboard/dashboardRoutes.js";

test("dashboard routes serve only the fixed local clinician assets", async () => {
  const server = createServer((request, response) => {
    void handleObjectiveDashboardRequest(request, response)
      .then((handled) => {
        if (!handled) response.writeHead(404).end("Not Found\n");
      })
      .catch((error: unknown) => {
        response.writeHead(500).end(error instanceof Error ? error.message : "route error");
      });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  const origin = `http://127.0.0.1:${address.port}`;

  try {
    const page = await fetch(`${origin}/clinician/objective`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
    const html = await page.text();
    for (const chartId of ["ecg-chart", "ppg-chart", "gsr-chart", "imu-chart", "temperature-chart"]) {
      assert.match(html, new RegExp(`id="${chartId}"`));
    }
    for (const controlId of [
      "live-mode-button",
      "review-mode-button",
      "review-session-select",
      "replay-play-button",
      "replay-restart-button",
      "replay-seek",
    ]) {
      assert.match(html, new RegExp(`id="${controlId}"`));
    }
    for (const speed of ["0.5", "1", "2", "4"]) {
      assert.match(html, new RegExp(`<option value="${speed}"`));
    }
    assert.match(html, /\/objective-assets\/uPlot\.iife\.min\.js/);
    assert.doesNotMatch(html, /https?:\/\//);

    const javascript = await fetch(`${origin}/objective-assets/objective.js`);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type") ?? "", /^text\/javascript/);
    const source = await javascript.text();
    assert.match(source, /plotT0Ms \+ sample\[0\] \/ 1_000/);
    assert.match(source, /sample\[1\] \/ 16_384/);
    assert.match(source, /sample\[1\] \* 0\.0078125/);
    assert.match(source, /buffer\.data\[column\]\.push\(null\)/);
    assert.match(source, /packet\.epoch_id !== state\.currentEpochId/);
    assert.match(source, /currentSequence > state\.lastLiveSequence \+ 1/);
    assert.match(source, /Live delivery gap before seq/);
    assert.match(source, /state\.mode !== "live"/);
    assert.match(source, /\/replay`/);
    assert.match(source, /\/replay\/packets\?from_ms=/);
    assert.match(source, /const MAX_REPLAY_CACHE_CHUNKS = 3/);
    assert.match(source, /replayPositionMs \+ elapsedRealMs \* state\.review\.replaySpeed/);
    assert.match(source, /requestAnimationFrame\(replayAnimationFrame\)/);
    assert.match(source, /baseMs \+ sample\[0\] \/ 1_000/);
    assert.match(source, /packet\.history_gap_before > 0/);
    assert.match(source, /packet\.boot_id !== previousPacket\.boot_id/);
    assert.match(source, /packet\.epoch_id !== previousPacket\.epoch_id/);
    assert.match(source, /Stored-history gap/);
    assert.match(source, /Time\/backend epoch/);
    assert.match(source, /buffer\.plot\.setScale\("x", \{ min: viewport\.min, max: viewport\.max \}\)/);

    const uplot = await fetch(`${origin}/objective-assets/uPlot.iife.min.js`);
    assert.equal(uplot.status, 200);
    assert.match(uplot.headers.get("content-type") ?? "", /^text\/javascript/);
    assert.ok((await uplot.arrayBuffer()).byteLength > 40_000);

    const unknown = await fetch(`${origin}/objective-assets/not-allowlisted.js`);
    assert.equal(unknown.status, 404);
    const traversal = await fetch(`${origin}/objective-assets/%2e%2e/package.json`);
    assert.equal(traversal.status, 404);
  } finally {
    server.close();
    await once(server, "close");
  }
});
