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
      "review-summary",
      "timeline-marker-rail",
      "review-focus-controls",
      "inspection-panel",
      "inspection-time",
      "analysis-pattern",
      "analysis-evidence",
      "analysis-window",
      "analysis-supporting-signals",
      "analysis-feature-summary",
      "analysis-quality-summary",
      "analysis-rule-list",
      "analysis-activity",
      "analysis-collection-window",
      "analysis-collection-progress",
      "analysis-latest-completed",
      "analysis-result-received",
      "analysis-source-trace",
      "analysis-modality-grid",
      "analysis-fired-rules",
      "recent-analysis-windows",
      "final-analysis-content",
      "final-session-coverage",
      "final-session-quality",
      "final-session-baseline",
      "final-session-rules",
      "final-session-multimodal",
      "final-session-trends",
      "final-session-observations",
    ]) {
      assert.match(html, new RegExp(`id="${controlId}"`));
    }
    for (const speed of ["0.5", "1", "2", "4"]) {
      assert.match(html, new RegExp(`<option value="${speed}"`));
    }
    for (const label of [
      "Persisted packets",
      "Ingestion gaps",
      "Stored-history gaps",
      "Truncated packets",
      "Device reboot",
      "Time/backend epoch",
      "Shared inspection",
      "Nearest sample at or before position",
    ]) {
      assert.match(html, new RegExp(label));
    }
    assert.doesNotMatch(html, /quality score|confidence %|stress state|impairment state/i);
    assert.match(html, /\/objective-assets\/uPlot\.iife\.min\.js/);
    assert.doesNotMatch(html, /https?:\/\//);

    const javascript = await fetch(`${origin}/objective-assets/objective.js`);
    assert.equal(javascript.status, 200);
    assert.match(javascript.headers.get("content-type") ?? "", /^text\/javascript/);
    const source = await javascript.text();
    assert.match(source, /plotT0Ms \+ sample\[0\] \/ 1_000/);
    assert.match(source, /sample\[1\] \/ 16_384/);
    assert.match(source, /sample\[1\] \* 0\.0078125/);
    assert.match(source, /packet\.epoch_id !== state\.currentEpochId/);
    assert.doesNotMatch(source, /markDiscontinuity/);
    assert.doesNotMatch(source, /Live delivery gap before seq/);
    assert.doesNotMatch(source, /currentSequence > state\.lastLiveSequence \+ 1/);
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
    assert.match(source, /key: "objective-review-inspection"/);
    assert.match(source, /hooks: \{ setCursor: \[handleReviewCursor\] \}/);
    assert.match(source, /message\.type === "analysis_update"/);
    assert.match(source, /handleLiveAnalysisUpdate\(message\.result\)/);
    assert.match(source, /MAX_LIVE_ANALYSIS_WINDOWS = 12/);
    assert.match(source, /function renderAnalysisActivity\(status, session\)/);
    assert.match(source, /delivered_analysis/);
    assert.match(source, /source\.analysis_input_gap_count/);
    assert.match(source, /function renderFinalAnalysisResult\(result\)/);
    assert.match(source, /MAX_FINAL_ANALYSIS_CACHE = 8/);
    assert.match(source, /FINAL_ANALYSIS_RETRY_LIMIT = 5/);
    assert.match(source, /Final session synthesis ready/);
    assert.match(source, /Finalizing session analysis… persistence pending/);
    assert.match(source, /No persisted final synthesis is available/);
    assert.match(source, /Final session synthesis could not be read/);
    assert.match(source, /loading its detailed result/);
    assert.match(source, /function renderReviewAnalysisWindows\(\)/);
    assert.match(source, /refreshFinalAnalysis\(sessionId, \{ mode: "review", generation/);
    assert.match(source, /finalAnalysisContextCurrent/);
    assert.match(source, /state\.review\.sessionId === sessionId/);
    assert.match(source, /context\.generation === state\.review\.selectionGeneration/);
    assert.match(source, /state\.review\.selectedAnalysisKey/);
    assert.match(source, /function fetchHistoricalAnalysis\(sessionId, fromMs, durationMs/);
    assert.match(source, /function renderHistoricalAnalysisAtCursor\(replayPositionMs\)/);
    assert.match(source, /startMs <= cursorMs/);
    assert.match(source, /cursorMs < endMs/);
    assert.match(source, /Analysis unavailable for this point\./);
    assert.match(source, /Analysis not available for this interval\./);
    assert.match(source, /analysis_version=/);
    assert.match(source, /sampleAtOrBefore\("ecg"/);
    assert.match(source, /sampleAtOrBefore\("ppg"/);
    assert.match(source, /sampleAtOrBefore\("gsr"/);
    assert.match(source, /sampleAtOrBefore\("imu"/);
    assert.match(source, /sampleAtOrBefore\("temp"/);
    assert.match(source, /requestedPosition > state\.review\.replayPositionMs/);
    assert.match(source, /Replay has not presented data at this cursor position yet/);
    assert.doesNotMatch(
      source,
      /Math\.min\(requestedPosition, state\.review\.replayPositionMs\)/,
    );
    assert.match(source, /latestContinuityBarrierAtOrBefore\(requestedPosition\)/);
    assert.match(source, /timeline\?\.gaps/);
    assert.match(source, /timeline\?\.segments/);
    assert.match(source, /sampleReplayMs >= continuousStartMs/);
    assert.match(source, /No signal samples after continuity boundary/);
    assert.match(source, /renderContinuityTimeline\(result\)/);
    assert.match(source, /timeline\.gaps/);
    assert.match(source, /timeline\.segments/);
    assert.match(source, /"Device reboot"/);
    assert.match(source, /"Time\/backend epoch"/);
    assert.doesNotMatch(source, /Epoch\/device reboot changed/);
    assert.match(source, /state\.review\.focusSignal = focus/);
    assert.match(source, /panel\.hidden = focus !== "all"/);

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
