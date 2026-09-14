import assert from "node:assert/strict";
import test from "node:test";

import { BaselineState } from "./analysis/baseline.js";

test("baseline collects eligible feature values only through 60 seconds and stores median/MAD", () => {
  const baseline = new BaselineState();
  for (let windowEnd = 10_000; windowEnd <= 60_000; windowEnd += 10_000) {
    baseline.observeWindow(windowEnd, [
      {
        modality: "ecg",
        feature: "heart_rate_bpm",
        value: windowEnd <= 40_000 ? 60 + windowEnd / 1_000 : null,
        valid: true,
        quality: windowEnd <= 40_000 ? "usable" : "limited",
      },
      {
        modality: "ppg",
        feature: "pulse_rate_bpm",
        value: windowEnd <= 40_000 ? 70 : null,
        valid: true,
        quality: windowEnd <= 40_000 ? "good" : "unavailable",
      },
      {
        modality: "gsr",
        feature: "gsr_raw_mean",
        value: 100,
        valid: true,
        quality: "usable",
      },
    ]);
  }

  const summary = baseline.getSummary();
  assert.equal(summary.collection_complete, true);
  assert.equal(summary.ready_modality_count, 3);
  assert.deepEqual(summary.ready_modalities, ["ecg", "ppg", "gsr"]);
  assert.deepEqual(baseline.getFeatureBaseline("ecg"), {
    state: "ready",
    eligible_window_count: 4,
    median: 85,
    mad: 10,
  });
  assert.deepEqual(baseline.getReference("ecg"), { median: 85, mad: 10 });

  baseline.observeWindow(70_000, [{
    modality: "temperature",
    feature: "temperature_mean_c",
    value: 30,
    valid: true,
    quality: "good",
  }]);
  assert.equal(baseline.isModalityReady("temperature"), false);
});
test("baseline with fewer than four eligible windows becomes permanently incomplete and resets cleanly", () => {
  const baseline = new BaselineState();
  for (let windowEnd = 10_000; windowEnd <= 60_000; windowEnd += 10_000) {
    baseline.observeWindow(windowEnd, windowEnd <= 30_000 ? [{
      modality: "ecg",
      feature: "heart_rate_bpm",
      value: 70,
      valid: true,
      quality: "good",
    }] : []);
  }
  assert.equal(baseline.getFeatureBaseline("ecg").state, "incomplete");
  assert.equal(baseline.isGlobalReady(), false);

  baseline.reset();
  assert.equal(baseline.getSummary().collection_complete, false);
  assert.equal(baseline.getFeatureBaseline("ecg").eligible_window_count, 0);
  assert.equal(baseline.getReference("ecg"), undefined);
});

test("zero MAD is preserved rather than replaced with an arbitrary spread", () => {
  const baseline = new BaselineState();
  for (let windowEnd = 10_000; windowEnd <= 60_000; windowEnd += 10_000) {
    baseline.observeWindow(windowEnd, [{
      modality: "gsr",
      feature: "gsr_raw_mean",
      value: 100,
      valid: true,
      quality: "usable",
    }]);
  }
  assert.equal(baseline.getFeatureBaseline("gsr").mad, 0);
});
