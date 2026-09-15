(() => {
  "use strict";

  const DEMO_MODE = /^\/clinician\/objective\/demo\/?$/.test(window.location.pathname);
  const API_BASE = DEMO_MODE ? "/api/objective/demo" : "/api/objective";
  const LIVE_WS_BASE = DEMO_MODE ? "/ws/objective/demo/live" : "/ws/objective/live";
  const STATUS_INTERVAL_MS = 1_000;
  const HISTORY_INTERVAL_MS = 10_000;
  const LIVE_RECONNECT_MS = 1_000;
  const REPLAY_CHUNK_MS = 30_000;
  const REPLAY_VIEWPORT_MS = 30_000;
  const MAX_REPLAY_CACHE_CHUNKS = 3;
  const MAX_LIVE_ANALYSIS_WINDOWS = 12;
  const MAX_FINAL_ANALYSIS_CACHE = 8;
  const FINAL_ANALYSIS_RETRY_LIMIT = 5;
  const FINAL_ANALYSIS_RETRY_DELAY_MS = 2_500;
  const ANALYSIS_VERSION = "analysis-2.0";
  const MODALITIES = ["ecg", "ppg", "gsr", "imu", "temperature"];
  const MODALITY_LABELS = {
    ecg: "ECG",
    ppg: "PPG",
    gsr: "GSR / EDA",
    imu: "IMU",
    temperature: "Temperature",
  };

  const state = {
    mode: "live",
    status: null,
    activeSessionId: null,
    configuredDeviceId: null,
    liveSocket: null,
    socketSessionId: null,
    reconnectTimer: null,
    actionPending: false,
    statusRefreshing: false,
    historyRefreshing: false,
    historySessions: [],
    currentEpochId: null,
    lastLiveBootId: null,
    liveAnalysisResult: null,
    liveAnalysisWindows: [],
    liveAnalysisSelectionKey: null,
    liveAnalysisReceivedAt: new Map(),
    lastAnalysisWindowEndMs: null,
    finalAnalysisSessionId: null,
    finalAnalysisLoadedSessionId: null,
    finalAnalysisFetchPending: false,
    finalAnalysisCache: new Map(),
    finalAnalysisRequests: new Map(),
    finalAnalysisRetryTimers: new Map(),
    finalAnalysisRetryAttempts: new Map(),
    previousRateSample: null,
    errorSource: null,
    demo: {
      scenarios: [],
      selectedScenarioId: null,
      status: null,
      loadingScenarios: false,
      guardTriggered: false,
    },
    review: {
      selectionGeneration: 0,
      sessionId: null,
      manifest: null,
      replayPositionMs: 0,
      replaySpeed: 1,
      playing: false,
      inspectionPositionMs: null,
      focusSignal: "all",
      selectedAnalysisKey: null,
      previousAnimationNow: null,
      animationFrame: null,
      cache: new Map(),
      analysisCache: new Map(),
    },
  };

  const byId = (id) => document.getElementById(id);
  const setText = (id, value) => { byId(id).textContent = value; };

  function formatNumber(value) {
    return Number.isFinite(value) ? new Intl.NumberFormat().format(value) : "—";
  }

  function formatTime(value) {
    if (!Number.isFinite(value)) return "—";
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "medium",
    }).format(new Date(value));
  }

  function formatReplayTime(value) {
    const totalMs = Math.max(0, Number.isFinite(value) ? value : 0);
    const minutes = Math.floor(totalMs / 60_000);
    const seconds = Math.floor((totalMs % 60_000) / 1_000);
    const milliseconds = Math.floor(totalMs % 1_000);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
  }

  function shortId(value) {
    if (!value) return "—";
    return value.length > 13 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
  }

  function setTone(element, tone) {
    element.classList.remove("good", "warn", "bad", "neutral");
    element.classList.add(tone);
  }

  function setBadge(id, text, tone) {
    const element = byId(id);
    element.textContent = text;
    setTone(element, tone);
  }

  function analysisFeatureValue(result, modality, feature, unit) {
    const value = result?.modality_results?.[modality]?.features?.[feature];
    if (!Number.isFinite(value)) return "unavailable";
    return `${formatNumber(value)}${unit ? ` ${unit}` : ""}`;
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function formatDurationMs(value) {
    const number = finiteNumber(value);
    return number === null ? "—" : formatReplayTime(Math.max(0, number));
  }

  function formatPercent(value) {
    const number = finiteNumber(value);
    return number === null ? "—" : `${Math.max(0, Math.min(100, number * 100)).toFixed(1)}%`;
  }

  function formatFeatureValue(value, meta) {
    if (meta?.valid === false || value === null || value === undefined) return "Unavailable";
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return "Unavailable";
      return `${formatNumber(value)}${meta?.unit ? ` ${meta.unit}` : ""}`;
    }
    if (typeof value === "string" || typeof value === "boolean") return String(value);
    return "Unavailable";
  }

  function featureLabel(feature) {
    return String(feature)
      .replaceAll("_", " ")
      .replace(/\b\w/g, (character) => character.toUpperCase());
  }

  function createDefinitionGrid(container, entries) {
    container.replaceChildren();
    for (const [label, value] of entries) {
      const item = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = value === null || value === undefined || value === "" ? "—" : String(value);
      item.append(term, detail);
      container.appendChild(item);
    }
  }

  function createTable(headers, rows, className = "") {
    const table = document.createElement("table");
    if (className) table.className = className;
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    headers.forEach((header) => {
      const cell = document.createElement("th");
      cell.textContent = header;
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    const body = document.createElement("tbody");
    rows.forEach((row) => {
      const tableRow = document.createElement("tr");
      row.forEach((value) => {
        const cell = document.createElement("td");
        cell.textContent = value === null || value === undefined ? "—" : String(value);
        tableRow.appendChild(cell);
      });
      body.appendChild(tableRow);
    });
    table.appendChild(body);
    return table;
  }

  function analysisIdentity(result) {
    return [
      result?.session_id ?? "",
      result?.epoch_id ?? "",
      result?.window?.start_ms ?? "",
      result?.window?.end_ms ?? "",
    ].join("|");
  }

  function windowNumber(result) {
    const start = finiteNumber(result?.window?.start_ms);
    return start === null ? null : Math.max(1, Math.floor(start / 10_000) + 1);
  }

  function windowRangeLabel(result, envelope) {
    const replayStart = finiteNumber(envelope?.replay_start_ms);
    const replayEnd = finiteNumber(envelope?.replay_end_ms);
    const window = result?.window ?? {};
    const start = replayStart ?? finiteNumber(window.start_ms);
    const end = replayEnd ?? finiteNumber(window.end_ms);
    if (start === null || end === null) return "Unknown window range";
    return `T+${formatReplayTime(start)} – T+${formatReplayTime(end)}`;
  }

  function renderAnalysisBaseline(result) {
    const baseline = result.baseline ?? {};
    const readyModalities = Array.isArray(baseline.ready_modalities) ? baseline.ready_modalities : [];
    const eligible = Array.isArray(result.baseline_update?.eligible_modalities)
      ? result.baseline_update.eligible_modalities
      : [];
    const states = baseline.modality_states ?? {};
    const stateText = result.baseline_ready === true
      ? "Ready"
      : baseline.collection_complete === true
        ? "Collection complete · incomplete readiness"
        : "Building";
    setText("analysis-baseline-ready", stateText);
    setTone(byId("analysis-baseline-ready"), result.baseline_ready === true ? "good" : "warn");
    createDefinitionGrid(byId("analysis-baseline-detail"), [
      ["Baseline used before this window", result.baseline_ready === true ? "Ready" : "Building / incomplete"],
      ["Collection complete", baseline.collection_complete === true ? "Yes" : "No"],
      ["Ready modalities", `${readyModalities.length}/5 · ${readyModalities.map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(", ") || "None"}`],
      ["Eligible for next baseline", eligible.map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(", ") || "None"],
      ...MODALITIES.map((modality) => [
        MODALITY_LABELS[modality],
        states[modality]?.state ?? "Unavailable",
      ]),
      ["Next baseline state", result.baseline_update?.baseline_after?.collection_complete === true ? "Collection complete" : "Still building / incomplete"],
    ]);
  }

  function renderAnalysisSource(result) {
    const source = result.source ?? {};
    const packetGapCount = finiteNumber(source.packet_gap_count) ?? 0;
    const sampleGapCount = finiteNumber(source.sample_gap_count) ?? 0;
    const truncatedCount = finiteNumber(source.truncated_packet_count) ?? 0;
    const inputGapCount = finiteNumber(source.analysis_input_gap_count) ?? 0;
    const discardedCount = finiteNumber(source.discarded_out_of_order_samples) ?? 0;
    const continuityProblems = packetGapCount + sampleGapCount + truncatedCount + inputGapCount + discardedCount;
    setText("analysis-continuity-state", continuityProblems === 0 ? "Continuity clean" : `${continuityProblems} continuity flags`);
    setTone(byId("analysis-continuity-state"), continuityProblems === 0 ? "good" : "warn");
    createDefinitionGrid(byId("analysis-source-trace"), [
      ["Packet count", formatNumber(finiteNumber(source.packet_count))],
      ["First / last packet", `${formatNumber(finiteNumber(source.first_packet_seq))} / ${formatNumber(finiteNumber(source.last_packet_seq))}`],
      ["Packet gaps", formatNumber(packetGapCount)],
      ["Sample gaps", formatNumber(sampleGapCount)],
      ["Truncated packets", formatNumber(truncatedCount)],
      ["Analysis-input gaps", formatNumber(inputGapCount)],
      ["Out-of-order samples discarded", formatNumber(discardedCount)],
      ["Modalities present", (source.modalities_present ?? []).map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(", ") || "None"],
    ]);
  }

  function ruleStatusText(evaluation) {
    const evidence = Array.isArray(evaluation.evidence) && evaluation.evidence.length > 0
      ? ` · ${evaluation.evidence.join("; ")}`
      : "";
    const threshold = evaluation.threshold_source ? ` · threshold: ${evaluation.threshold_source}` : "";
    const inputs = evaluation.inputs && Object.keys(evaluation.inputs).length > 0
      ? ` · inputs: ${JSON.stringify(evaluation.inputs)}`
      : "";
    return `${evaluation.rule_id}${evidence}${threshold}${inputs}`;
  }

  function renderAnalysisModalityDetails(result) {
    const container = byId("analysis-modality-grid");
    container.replaceChildren();
    for (const modality of MODALITIES) {
      const detail = result.modality_results?.[modality] ?? {};
      const quality = detail.quality ?? {};
      const card = document.createElement("article");
      card.className = "modality-card";
      const heading = document.createElement("h4");
      heading.textContent = MODALITY_LABELS[modality];
      const qualityLine = document.createElement("p");
      qualityLine.className = `modality-quality quality-${quality.state ?? "unavailable"}`;
      qualityLine.textContent = `${quality.state ?? "unavailable"} · ${formatNumber(finiteNumber(quality.sample_count))}/${formatNumber(finiteNumber(quality.expected_sample_count))} samples · ${formatPercent(quality.coverage_fraction)} coverage`;
      card.append(heading, qualityLine);

      const qualityTable = createTable(["Quality detail", "Value"], [
        ["Maximum gap", formatDurationMs(quality.max_gap_ms)],
        ["Packet gap", quality.packet_gap === true ? "Yes" : "No"],
        ["Reasons", Array.isArray(quality.reason_codes) && quality.reason_codes.length > 0 ? quality.reason_codes.join(", ") : "None recorded"],
      ]);
      card.appendChild(qualityTable);

      const featureRows = Object.entries(detail.features ?? {}).map(([feature, value]) => [
        featureLabel(feature),
        formatFeatureValue(value, detail.feature_meta?.[feature]),
      ]);
      card.appendChild(createTable(["Feature", "Value"], featureRows));

      const relations = Object.entries(detail.feature_meta ?? {})
        .filter(([, meta]) => meta?.baseline !== null && meta?.baseline !== undefined)
        .map(([feature, meta]) => {
          const relation = meta.baseline;
          return `${featureLabel(feature)}: Δ ${formatFeatureValue(relation?.delta, { unit: meta.unit, valid: relation?.delta !== null })}, change ${formatFeatureValue(relation?.percent_change, { unit: "%", valid: relation?.percent_change !== null })}, z ${formatFeatureValue(relation?.robust_z, { unit: "", valid: relation?.robust_z !== null })}`;
        });
      if (relations.length > 0) {
        const relationDetails = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Baseline relation details";
        const list = document.createElement("ul");
        relations.forEach((relation) => {
          const item = document.createElement("li");
          item.textContent = relation;
          list.appendChild(item);
        });
        relationDetails.append(summary, list);
        card.appendChild(relationDetails);
      }

      const evaluations = Array.isArray(detail.rule_evaluations) ? detail.rule_evaluations : [];
      if (evaluations.length > 0) {
        const ruleDetails = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = `Rule evaluations (${evaluations.length})`;
        const list = document.createElement("ul");
        evaluations.forEach((evaluation) => {
          const item = document.createElement("li");
          const status = document.createElement("span");
          status.className = `rule-status ${evaluation.status}`;
          status.textContent = evaluation.status.replace("_", " ");
          item.append(status, document.createTextNode(ruleStatusText(evaluation)));
          list.appendChild(item);
        });
        ruleDetails.append(summary, list);
        card.appendChild(ruleDetails);
      }
      container.appendChild(card);
    }
  }

  function renderAnalysisRules(result) {
    const evaluations = [];
    for (const modality of MODALITIES) {
      for (const evaluation of result.modality_results?.[modality]?.rule_evaluations ?? []) {
        evaluations.push({ ...evaluation, modality });
      }
    }
    const multimodalRuleIds = result.multimodal_result?.rule_ids ?? [];
    for (const ruleId of multimodalRuleIds) {
      evaluations.push({
        rule_id: ruleId,
        status: "fired",
        inputs: {},
        evidence: [result.multimodal_result?.explanation ?? "Multimodal rule fired"],
        threshold_source: "prototype_heuristic",
        modality: "multimodal",
      });
    }
    const uniqueEvaluations = evaluations.filter((evaluation, index, values) =>
      values.findIndex((candidate) => candidate.rule_id === evaluation.rule_id && candidate.modality === evaluation.modality) === index);
    const fired = uniqueEvaluations.filter((evaluation) => evaluation.status === "fired");
    setText("analysis-fired-rule-count", `${fired.length} fired · ${uniqueEvaluations.length} evaluated`);
    setTone(byId("analysis-fired-rule-count"), fired.length > 0 ? "good" : "neutral");
    const firedContainer = byId("analysis-fired-rules");
    firedContainer.replaceChildren();
    fired.forEach((evaluation) => {
      const chip = document.createElement("span");
      chip.className = "fired-rule";
      chip.textContent = evaluation.rule_id;
      chip.title = ruleStatusText(evaluation);
      firedContainer.appendChild(chip);
    });
    const list = byId("analysis-rule-list");
    list.replaceChildren();
    if (uniqueEvaluations.length === 0) {
      const item = document.createElement("li");
      item.textContent = "No deterministic rule evaluations were recorded.";
      list.appendChild(item);
      return;
    }
    uniqueEvaluations.forEach((evaluation) => {
      const item = document.createElement("li");
      item.className = `${evaluation.status}-rule-row`;
      const status = document.createElement("span");
      status.className = `rule-status ${evaluation.status}`;
      status.textContent = evaluation.status.replace("_", " ");
      item.append(status, document.createTextNode(`${evaluation.rule_id} · ${ruleStatusText(evaluation)}`));
      list.appendChild(item);
    });
  }

  function renderAnalysisResult(result, options = {}) {
    const empty = byId("analysis-empty");
    const content = byId("analysis-content");
    if (!result || typeof result !== "object") {
      empty.textContent = options.emptyMessage ?? "Analysis unavailable for this point.";
      empty.hidden = false;
      content.hidden = true;
      return;
    }

    const multimodal = result.multimodal_result ?? {};
    const window = result.window ?? {};
    const completedWindowNumber = windowNumber(result);
    const supporting = Array.isArray(multimodal.supporting_modalities)
      ? multimodal.supporting_modalities.map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(" · ")
      : "None recorded";
    const contradicting = Array.isArray(multimodal.contradicting_modalities)
      ? multimodal.contradicting_modalities.map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(" · ")
      : "None recorded";
    setText(
      "analysis-context",
      options.mode === "review"
        ? "Historical completed window"
        : completedWindowNumber === null ? "Completed window" : `Completed W${completedWindowNumber}`,
    );
    setText("analysis-pattern", multimodal.pattern ?? "No pattern recorded");
    setText("analysis-evidence", multimodal.evidence_tier ?? "insufficient");
    setText("analysis-window", `${windowRangeLabel(result, options.envelope)} · epoch ${shortId(result.epoch_id)}${completedWindowNumber === null ? "" : ` · W${completedWindowNumber}`}`);
    setText("analysis-version", result.analysis_version ?? "Unavailable");
    setText("analysis-explanation", multimodal.explanation ?? "No explanation recorded.");
    setText("analysis-supporting-signals", `Supporting: ${supporting} · Contradicting: ${contradicting}`);
    setText("analysis-created-at", formatTime(finiteNumber(result.created_at_ms)));
    setText("analysis-feature-summary", MODALITIES.map((modality) => {
      const features = result.modality_results?.[modality]?.features ?? {};
      const key = modality === "ecg" ? "heart_rate_bpm" : modality === "ppg" ? "pulse_rate_bpm" : modality === "gsr" ? "gsr_raw_mean" : modality === "imu" ? "motion_index_g" : "temperature_mean_c";
      return `${MODALITY_LABELS[modality]} ${formatFeatureValue(features[key], result.modality_results?.[modality]?.feature_meta?.[key])}`;
    }).join(" · "));
    setText("analysis-quality-summary", MODALITIES.map((modality) => `${MODALITY_LABELS[modality]} ${result.modality_results?.[modality]?.quality?.state ?? "unavailable"}`).join(" · "));
    renderAnalysisBaseline(result);
    renderAnalysisSource(result);
    renderAnalysisModalityDetails(result);
    renderAnalysisRules(result);
    empty.hidden = true;
    content.hidden = false;
  }

  function renderAnalysisWindowList(rows, options = {}) {
    const list = byId("recent-analysis-windows");
    const empty = byId("recent-analysis-empty");
    list.replaceChildren();
    empty.hidden = rows.length > 0;
    for (const row of rows) {
      const result = row.result ?? row.envelope?.result;
      const key = row.key ?? analysisIdentity(result);
      const item = document.createElement("li");
      item.className = "recent-analysis-row";
      item.classList.toggle("selected", key === options.selectedKey);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "recent-analysis-button";
      const number = windowNumber(result);
      const title = document.createElement("strong");
      title.textContent = `${number === null ? "Completed" : `W${number}`} · ${result?.multimodal_result?.evidence_tier ?? "insufficient"}`;
      const range = document.createElement("span");
      range.textContent = `${windowRangeLabel(result, row.envelope)} · ${result?.multimodal_result?.pattern ?? "No pattern"}`;
      const quality = document.createElement("span");
      quality.textContent = MODALITIES.map((modality) => `${modality.toUpperCase()} ${result?.modality_results?.[modality]?.quality?.state ?? "unavailable"}`).join(" · ");
      button.append(title, range, quality);
      button.addEventListener("click", () => options.onSelect?.(key, row));
      item.appendChild(button);
      list.appendChild(item);
    }
  }

  function renderLiveAnalysisWindows() {
    const rows = state.liveAnalysisWindows.map((result) => ({ result, key: analysisIdentity(result) }));
    setText("recent-analysis-context", rows.length > 0 ? `${rows.length} recent completed windows · live` : "Updated by completed results");
    const receivedAt = state.liveAnalysisReceivedAt.get(state.liveAnalysisSelectionKey);
    setText("analysis-result-received", receivedAt === undefined ? "Not received in this browser" : formatTime(receivedAt));
    renderAnalysisWindowList(rows, {
      selectedKey: state.liveAnalysisSelectionKey,
      onSelect: (key, row) => {
        state.liveAnalysisSelectionKey = key;
        state.liveAnalysisResult = row.result;
        renderAnalysisResult(row.result, { mode: "live" });
        renderLiveAnalysisWindows();
      },
    });
  }

  function clearLiveAnalysis(clearPanel = state.mode === "live", clearHistory = true) {
    if (clearHistory) {
      state.liveAnalysisResult = null;
      state.lastAnalysisWindowEndMs = null;
      state.liveAnalysisWindows = [];
      state.liveAnalysisSelectionKey = null;
      state.liveAnalysisReceivedAt.clear();
    } else if (state.liveAnalysisResult !== null) {
      state.liveAnalysisSelectionKey = analysisIdentity(state.liveAnalysisResult);
    }
    renderLiveAnalysisWindows();
    if (clearPanel) renderAnalysisResult(null);
  }

  function renderFinalAnalysisResult(result) {
    const session = result.session ?? {};
    const coverage = result.window_coverage ?? {};
    const quality = result.quality ?? {};
    const baseline = result.baseline ?? {};
    const missing = Array.isArray(coverage.missing_windows) ? coverage.missing_windows : [];
    const tails = Array.isArray(coverage.incomplete_tails) ? coverage.incomplete_tails : [];
    setText("final-analysis-version", result.analysis_version ?? "Unavailable");
    createDefinitionGrid(byId("final-session-coverage"), [
      ["Analysis version", result.analysis_version ?? "Unavailable"],
      ["Duration", formatDurationMs(session.duration_ms)],
      ["Start / end", `${formatDurationMs(session.start_ms)} → ${formatDurationMs(session.end_ms)}`],
      ["Epochs", `${formatNumber(session.epoch_count)} · ${(session.epoch_ids ?? []).map(shortId).join(", ") || "None"}`],
      ["Completed windows", formatNumber(session.completed_window_count)],
      ["Incomplete tail", session.incomplete_tail_present === true ? formatDurationMs(session.incomplete_tail_duration_ms) : "None"],
      ["Finalized", formatTime(finiteNumber(session.finalization_timestamp_ms))],
      ["Missing windows", missing.length === 0 ? "None" : `${missing.length} · ${missing.map((window) => `${shortId(window.epoch_id)} ${formatDurationMs(window.start_ms)}–${formatDurationMs(window.end_ms)} (${window.reason})`).join("; ")}`],
      ["Incomplete tails", tails.length === 0 ? "None" : tails.map((tail) => `${shortId(tail.epoch_id)} ${formatDurationMs(tail.start_ms)}–${formatDurationMs(tail.end_ms)} (${formatDurationMs(tail.duration_ms)})`).join("; ")],
    ]);

    const qualityRows = MODALITIES.map((modality) => {
      const counts = quality.modality_quality_states?.[modality] ?? {};
      return [
        MODALITY_LABELS[modality],
        formatNumber(finiteNumber(counts.good)),
        formatNumber(finiteNumber(counts.usable)),
        formatNumber(finiteNumber(counts.limited)),
        formatNumber(finiteNumber(counts.unavailable)),
      ];
    });
    const qualityContainer = byId("final-session-quality");
    qualityContainer.replaceChildren(
      createTable(["Modality", "Good", "Usable", "Limited", "Unavailable"], qualityRows),
    );
    const qualityNote = document.createElement("p");
    qualityNote.className = "final-analysis-note";
    qualityNote.textContent = `Source totals · packets ${formatNumber(finiteNumber(quality.packet_count))} · packet gaps ${formatNumber(finiteNumber(quality.packet_gap_count))} · sample gaps ${formatNumber(finiteNumber(quality.sample_gap_count))} · truncated ${formatNumber(finiteNumber(quality.truncated_packet_count))} · analysis-input gaps ${formatNumber(finiteNumber(quality.analysis_input_gap_count))}`;
    qualityContainer.appendChild(qualityNote);

    const baselineContainer = byId("final-session-baseline");
    baselineContainer.replaceChildren();
    createDefinitionGrid(baselineContainer, [
      ["Collection complete", baseline.collection_complete === true ? "Yes" : "No"],
      ["Ready modalities", `${(baseline.ready_modalities ?? []).length}/5 · ${(baseline.ready_modalities ?? []).map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(", ") || "None"}`],
    ]);
    if (baseline.summary?.modality_states) {
      const states = document.createElement("p");
      states.className = "final-analysis-note";
      states.textContent = MODALITIES.map((modality) => `${MODALITY_LABELS[modality]}: ${baseline.summary.modality_states[modality]?.state ?? "unavailable"}`).join(" · ");
      baselineContainer.appendChild(states);
    }

    const ruleRows = Object.entries(result.rule_summary ?? {})
      .sort(([, left], [, right]) => Number(right.fired_window_count ?? 0) - Number(left.fired_window_count ?? 0))
      .map(([ruleId, summary]) => [
        ruleId,
        formatNumber(finiteNumber(summary.fired_window_count)),
        summary.first_fired_window ? `W${Math.max(1, Math.floor(Number(summary.first_fired_window.start_ms) / 10_000) + 1)}` : "Never",
        summary.last_fired_window ? `W${Math.max(1, Math.floor(Number(summary.last_fired_window.start_ms) / 10_000) + 1)}` : "—",
        formatNumber(finiteNumber(summary.longest_consecutive_run)),
      ]);
    byId("final-session-rules").replaceChildren(
      ruleRows.length > 0
        ? createTable(["Rule", "Fired windows", "First", "Last", "Longest run"], ruleRows)
        : Object.assign(document.createElement("p"), { className: "final-analysis-note", textContent: "No rule summary entries were persisted." }),
    );

    const multimodal = result.multimodal_summary ?? {};
    const patternRows = Object.entries(multimodal.patterns ?? {}).map(([pattern, summary]) => [
      pattern,
      formatNumber(finiteNumber(summary.count)),
      summary.first_window ? `W${Math.max(1, Math.floor(Number(summary.first_window.start_ms) / 10_000) + 1)}` : "—",
      summary.last_window ? `W${Math.max(1, Math.floor(Number(summary.last_window.start_ms) / 10_000) + 1)}` : "—",
      (summary.supporting_modalities ?? []).map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(", ") || "None",
      (summary.evidence_tiers ?? []).join(", ") || "—",
    ]);
    const multimodalContainer = byId("final-session-multimodal");
    multimodalContainer.replaceChildren(
      patternRows.length > 0
        ? createTable(["Pattern", "Count", "First", "Last", "Supporting", "Evidence tiers"], patternRows)
        : Object.assign(document.createElement("p"), { className: "final-analysis-note", textContent: "No multimodal patterns were persisted." }),
    );
    const multimodalNote = document.createElement("p");
    multimodalNote.className = "final-analysis-note";
    multimodalNote.textContent = `Contradiction windows: ${formatNumber(finiteNumber(multimodal.contradiction_window_count))} · Evidence tiers: ${Object.entries(multimodal.evidence_tier_counts ?? {}).map(([tier, count]) => `${tier} ${count}`).join(" · ") || "None"}`;
    multimodalContainer.appendChild(multimodalNote);

    const trendsContainer = byId("final-session-trends");
    trendsContainer.replaceChildren();
    for (const modality of MODALITIES) {
      const trends = result.feature_trends?.[modality] ?? {};
      const entries = Object.entries(trends);
      if (entries.length === 0) continue;
      const heading = document.createElement("h5");
      heading.textContent = MODALITY_LABELS[modality];
      trendsContainer.appendChild(heading);
      trendsContainer.appendChild(createTable(
        ["Feature", "Valid windows", "First", "Last", "Median", "Change"],
        entries.map(([feature, trend]) => [
          featureLabel(feature),
          formatNumber(finiteNumber(trend.valid_window_count)),
          formatFeatureValue(trend.first_valid, { valid: trend.first_valid !== null }),
          formatFeatureValue(trend.last_valid, { valid: trend.last_valid !== null }),
          formatFeatureValue(trend.median, { valid: trend.median !== null }),
          formatFeatureValue(trend.change_from_first_to_last, { valid: trend.change_from_first_to_last !== null }),
        ]),
      ));
    }
    if (trendsContainer.children.length === 0) {
      const note = document.createElement("p");
      note.className = "final-analysis-note";
      note.textContent = "No valid feature trends were persisted.";
      trendsContainer.appendChild(note);
    }

    const observations = Array.isArray(result.window_observations) ? result.window_observations : [];
    const observationRows = observations.map((observation) => [
      `W${Math.max(1, Math.floor(Number(observation.window?.start_ms ?? 0) / 10_000) + 1)}`,
      formatDurationMs(observation.window?.start_ms),
      formatDurationMs(observation.window?.end_ms),
      (observation.rules_triggered ?? []).join(", ") || "None",
      observation.multimodal_pattern ?? "—",
      observation.evidence_tier ?? "—",
      (observation.supporting_modalities ?? []).map((modality) => MODALITY_LABELS[modality] ?? String(modality)).join(", ") || "None",
    ]);
    byId("final-session-observations").replaceChildren(
      observationRows.length > 0
        ? createTable(["Window", "Start", "End", "Rules", "Pattern", "Evidence", "Supporting"], observationRows)
        : Object.assign(document.createElement("p"), { className: "final-analysis-note", textContent: "No completed window observations were persisted." }),
    );
  }

  function renderFinalAnalysisState(finalAnalysis, sessionId = state.finalAnalysisSessionId, options = {}) {
    const stateText = finalAnalysis?.state ?? "unavailable";
    const result = finalAnalysis?.result;
    setText("final-analysis-state", sessionId ? `${stateText} · ${shortId(sessionId)}` : stateText);
    if (stateText === "complete" && result?.session) {
      renderFinalAnalysisResult(result);
      byId("final-analysis-content").hidden = false;
      const completed = finiteNumber(result.session.completed_window_count) ?? 0;
      const tail = result.session.incomplete_tail_present === true
        ? ` · incomplete tail ${formatDurationMs(result.session.incomplete_tail_duration_ms)}`
        : "";
      setText("analysis-final-summary", `${DEMO_MODE ? "Scenario-phase final synthesis ready" : "Final session synthesis ready"} · ${formatNumber(completed)} completed windows${tail}.`);
    } else if (stateText === "complete") {
      byId("final-analysis-content").hidden = true;
      setText("analysis-final-summary", DEMO_MODE ? "Scenario-phase final synthesis is ready; loading its detailed result…" : "Final session synthesis is persisted; loading its detailed result…");
    } else if (stateText === "pending") {
      byId("final-analysis-content").hidden = true;
      setText("analysis-final-summary", options.loading === true
        ? "Loading final session synthesis…"
        : DEMO_MODE ? "Finalizing scenario-phase analysis while completed windows drain." : "Finalizing session analysis… persistence pending while completed windows drain.");
    } else if (stateText === "error") {
      byId("final-analysis-content").hidden = true;
      setText("analysis-final-summary", "Final session synthesis could not be read because the analysis path reported an error.");
    } else {
      byId("final-analysis-content").hidden = true;
      setText("analysis-final-summary", options.mode === "review"
        ? DEMO_MODE ? `No scenario-phase final synthesis is available for ${shortId(sessionId)} at ${ANALYSIS_VERSION}.` : `No persisted final synthesis is available for ${shortId(sessionId)} at ${ANALYSIS_VERSION}.`
        : sessionId
          ? DEMO_MODE ? "Scenario-phase final synthesis will be available after the visible demo completes." : "Final session synthesis will be available after STOP and persistence completes."
          : "No final session synthesis is selected.");
    }
  }

  function finalAnalysisContextCurrent(sessionId, context) {
    if (context.mode === "review") {
      return state.mode === "review" &&
        state.review.sessionId === sessionId &&
        context.generation === state.review.selectionGeneration;
    }
    return state.mode === "live" && state.finalAnalysisSessionId === sessionId;
  }

  function cacheFinalAnalysis(sessionId, finalAnalysis) {
    state.finalAnalysisCache.delete(sessionId);
    state.finalAnalysisCache.set(sessionId, finalAnalysis);
    while (state.finalAnalysisCache.size > MAX_FINAL_ANALYSIS_CACHE) {
      state.finalAnalysisCache.delete(state.finalAnalysisCache.keys().next().value);
    }
  }

  function clearFinalAnalysisRetry(sessionId) {
    const timer = state.finalAnalysisRetryTimers.get(sessionId);
    if (timer !== undefined) window.clearTimeout(timer);
    state.finalAnalysisRetryTimers.delete(sessionId);
    state.finalAnalysisRetryAttempts.delete(sessionId);
  }

  function scheduleFinalAnalysisRetry(sessionId, context) {
    if ((state.finalAnalysisRetryAttempts.get(sessionId) ?? 0) >= FINAL_ANALYSIS_RETRY_LIMIT) return;
    if (state.finalAnalysisRetryTimers.has(sessionId)) return;
    const attempts = (state.finalAnalysisRetryAttempts.get(sessionId) ?? 0) + 1;
    state.finalAnalysisRetryAttempts.set(sessionId, attempts);
    const timer = window.setTimeout(() => {
      state.finalAnalysisRetryTimers.delete(sessionId);
      if (finalAnalysisContextCurrent(sessionId, context)) void refreshFinalAnalysis(sessionId, context);
    }, FINAL_ANALYSIS_RETRY_DELAY_MS);
    state.finalAnalysisRetryTimers.set(sessionId, timer);
  }

  async function refreshFinalAnalysis(sessionId, context = {}) {
    if (!sessionId) return null;
    const requestContext = {
      mode: context.mode ?? state.mode,
      generation: context.generation ?? state.review.selectionGeneration,
      loading: context.loading === true,
    };
    const cached = state.finalAnalysisCache.get(sessionId);
    if (cached?.state === "complete" || cached?.state === "unavailable" || cached?.state === "error") {
      if (finalAnalysisContextCurrent(sessionId, requestContext)) {
        state.finalAnalysisSessionId = sessionId;
        state.finalAnalysisLoadedSessionId = cached.state === "complete" ? sessionId : null;
        renderFinalAnalysisState(cached, sessionId, requestContext);
      }
      return cached;
    }
    if (cached?.state === "pending" &&
      (state.finalAnalysisRetryAttempts.get(sessionId) ?? 0) >= FINAL_ANALYSIS_RETRY_LIMIT) {
      if (finalAnalysisContextCurrent(sessionId, requestContext)) {
        state.finalAnalysisSessionId = sessionId;
        renderFinalAnalysisState(cached, sessionId, requestContext);
      }
      return cached;
    }
    const existing = state.finalAnalysisRequests.get(sessionId);
    if (existing !== undefined) {
      return existing.then((finalAnalysis) => {
        if (finalAnalysis.state === "pending") {
          if (finalAnalysisContextCurrent(sessionId, requestContext)) {
            clearFinalAnalysisRetry(sessionId);
            scheduleFinalAnalysisRetry(sessionId, requestContext);
          }
        } else {
          clearFinalAnalysisRetry(sessionId);
        }
        if (finalAnalysisContextCurrent(sessionId, requestContext)) {
          state.finalAnalysisSessionId = sessionId;
          state.finalAnalysisLoadedSessionId = finalAnalysis.state === "complete" ? sessionId : null;
          renderFinalAnalysisState(finalAnalysis, sessionId, requestContext);
        }
        return finalAnalysis;
      });
    }
    if (finalAnalysisContextCurrent(sessionId, requestContext)) {
      state.finalAnalysisSessionId = sessionId;
      renderFinalAnalysisState({ state: "pending" }, sessionId, requestContext);
    }
    state.finalAnalysisFetchPending = true;
    const request = requestJson(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/final-analysis`)
      .then((response) => {
        const finalAnalysis = response?.final_analysis ?? { state: "unavailable", available: false, result: null };
        cacheFinalAnalysis(sessionId, finalAnalysis);
        if (finalAnalysis.state === "pending") {
          scheduleFinalAnalysisRetry(sessionId, requestContext);
        } else {
          clearFinalAnalysisRetry(sessionId);
        }
        if (finalAnalysisContextCurrent(sessionId, requestContext)) {
          state.finalAnalysisSessionId = sessionId;
          state.finalAnalysisLoadedSessionId = finalAnalysis.state === "complete" ? sessionId : null;
          renderFinalAnalysisState(finalAnalysis, sessionId, requestContext);
        }
        return finalAnalysis;
      })
      .catch((error) => {
        const finalAnalysis = { state: "error", available: false, result: null, error: error.message };
        cacheFinalAnalysis(sessionId, finalAnalysis);
        clearFinalAnalysisRetry(sessionId);
        if (finalAnalysisContextCurrent(sessionId, requestContext)) {
          state.finalAnalysisSessionId = sessionId;
          renderFinalAnalysisState(finalAnalysis, sessionId, requestContext);
        }
        return finalAnalysis;
      })
      .finally(() => {
        state.finalAnalysisRequests.delete(sessionId);
        state.finalAnalysisFetchPending = state.finalAnalysisRequests.size > 0;
      });
    state.finalAnalysisRequests.set(sessionId, request);
    return request;
  }

  function showError(message, source) {
    const banner = byId("error-banner");
    banner.textContent = message;
    banner.hidden = false;
    state.errorSource = source;
  }

  function clearError(source) {
    if (source !== undefined && state.errorSource !== source) return;
    byId("error-banner").hidden = true;
    state.errorSource = null;
  }

  function chartOptions(element, series) {
    return {
      width: Math.max(320, element.clientWidth),
      height: 220,
      padding: [10, 8, 0, 2],
      cursor: {
        show: true,
        x: true,
        y: false,
        drag: { x: false, y: false },
        sync: {
          key: "objective-review-inspection",
          scales: ["x", null],
          filters: {
            pub: () => state.mode === "review",
            sub: () => state.mode === "review",
          },
        },
      },
      hooks: { setCursor: [handleReviewCursor] },
      legend: { show: series.length > 1 },
      scales: { x: { time: false } },
      axes: [
        {
          stroke: "#7f96aa",
          grid: { stroke: "#1d344a", width: 1 },
          ticks: { stroke: "#294760" },
          values: (_plot, values) => values.map((value) => `${(value / 1_000).toFixed(1)}s`),
        },
        {
          stroke: "#7f96aa",
          grid: { stroke: "#1d344a", width: 1 },
          ticks: { stroke: "#294760" },
          size: 58,
        },
      ],
      series: [
        {},
        ...series.map((entry) => ({
          label: entry.label,
          stroke: entry.color,
          width: 1.4,
          spanGaps: false,
          points: { show: false },
        })),
      ],
    };
  }

  function createRollingChart(elementId, windowMs, maxPoints, series) {
    const element = byId(elementId);
    const signalName = elementId.replace("-chart", "");
    const data = Array.from({ length: series.length + 1 }, () => []);
    const plot = new uPlot(chartOptions(element, series), data, element);
    const buffer = { data, plot, element, windowMs, maxPoints };

    const observer = new ResizeObserver(() => {
      const width = Math.floor(element.clientWidth);
      if (width > 0 && width !== plot.width) {
        const focused = state.mode === "review" && state.review.focusSignal === signalName;
        plot.setSize({ width, height: focused ? 340 : 220 });
      }
    });
    observer.observe(element);
    return buffer;
  }

  const charts = {
    ecg: createRollingChart("ecg-chart", 10_000, 7_000, [
      { label: "ADC", color: "#62d6c8" },
    ]),
    ppg: createRollingChart("ppg-chart", 10_000, 3_500, [
      { label: "RED", color: "#ff6b78" },
      { label: "IR", color: "#7bb4ff" },
    ]),
    gsr: createRollingChart("gsr-chart", 30_000, 10_000, [
      { label: "Raw", color: "#f1b85b" },
    ]),
    imu: createRollingChart("imu-chart", 10_000, 3_500, [
      { label: "Magnitude g", color: "#ad8cff" },
    ]),
    temperature: createRollingChart("temperature-chart", 60_000, 2_600, [
      { label: "°C", color: "#ff9d66" },
    ]),
  };

  function clearChart(buffer) {
    for (const values of buffer.data) values.length = 0;
    buffer.plot.setData(buffer.data);
  }

  function resetSignalReadings() {
    setText("ecg-lead-state", "Lead state —");
    setTone(byId("ecg-lead-state"), "neutral");
    setText("ppg-reading", "RED — · IR —");
    setText("gsr-reading", "Raw —");
    setText("imu-magnitude", "Magnitude — g");
    setText("imu-reading", "Accel — · Gyro —");
    setText("temperature-reading", "— °C");
  }

  function clearSignalState() {
    Object.values(charts).forEach(clearChart);
    state.currentEpochId = null;
    state.lastLiveBootId = null;
    clearLiveAnalysis(true);
    setText("epoch-state", "Waiting for data");
    resetSignalReadings();
  }

  function appendPoints(buffer, times, valueColumns) {
    if (times.length === 0) return;
    const xValues = buffer.data[0];

    xValues.push(...times);
    for (let column = 0; column < valueColumns.length; column += 1) {
      buffer.data[column + 1].push(...valueColumns[column]);
    }

    const cutoff = times[times.length - 1] - buffer.windowMs;
    let firstVisible = 0;
    while (firstVisible < xValues.length && xValues[firstVisible] < cutoff) firstVisible += 1;
    if (firstVisible > 0) {
      for (let column = 0; column < buffer.data.length; column += 1) {
        buffer.data[column].splice(0, firstVisible);
      }
    }
    const excessPoints = xValues.length - buffer.maxPoints;
    if (excessPoints > 0) {
      for (let column = 0; column < buffer.data.length; column += 1) {
        buffer.data[column].splice(0, excessPoints);
      }
    }
    buffer.plot.setData(buffer.data);
  }

  function sampleTimes(plotT0Ms, samples) {
    return samples.map((sample) => plotT0Ms + sample[0] / 1_000);
  }

  function processAcceptedPacket(packet) {
    if (!packet || packet.session_id !== state.activeSessionId || !packet.raw_packet) return;

    const bootChanged = state.lastLiveBootId !== null && packet.boot_id !== state.lastLiveBootId;
    let epochChanged = false;
    let boundaryLabel = null;
    if (state.currentEpochId === null) {
      state.currentEpochId = packet.epoch_id;
      setText("epoch-state", `Epoch ${shortId(packet.epoch_id)}`);
    } else if (packet.epoch_id !== state.currentEpochId) {
      epochChanged = true;
      const previousEpoch = state.currentEpochId;
      Object.values(charts).forEach(clearChart);
      clearLiveAnalysis();
      state.currentEpochId = packet.epoch_id;
      boundaryLabel = bootChanged ? "Device reboot" : "Time/backend epoch";
      setText("epoch-state", `${boundaryLabel} · ${shortId(previousEpoch)} → ${shortId(packet.epoch_id)}`);
    } else if (bootChanged) {
      Object.values(charts).forEach(clearChart);
      clearLiveAnalysis();
      boundaryLabel = "Device reboot";
      setText("epoch-state", `${boundaryLabel} · boot ${shortId(packet.boot_id)}`);
    }

    state.lastLiveBootId = packet.boot_id;

    const raw = packet.raw_packet;
    const base = packet.plot_t0_ms;

    if (Array.isArray(raw.ecg) && raw.ecg.length > 0) {
      appendPoints(charts.ecg, sampleTimes(base, raw.ecg), [raw.ecg.map((sample) => sample[1])]);
      const latest = raw.ecg[raw.ecg.length - 1];
      const leads = [];
      if (latest[2] === 1) leads.push("LO+");
      if (latest[3] === 1) leads.push("LO−");
      setText("ecg-lead-state", leads.length === 0 ? "Leads connected" : `Lead off ${leads.join(" / ")}`);
      setTone(byId("ecg-lead-state"), leads.length === 0 ? "good" : "warn");
    }

    if (Array.isArray(raw.ppg) && raw.ppg.length > 0) {
      appendPoints(charts.ppg, sampleTimes(base, raw.ppg), [
        raw.ppg.map((sample) => sample[1]),
        raw.ppg.map((sample) => sample[2]),
      ]);
      const latest = raw.ppg[raw.ppg.length - 1];
      setText("ppg-reading", `RED ${formatNumber(latest[1])} · IR ${formatNumber(latest[2])}`);
    }

    if (Array.isArray(raw.gsr) && raw.gsr.length > 0) {
      appendPoints(charts.gsr, sampleTimes(base, raw.gsr), [raw.gsr.map((sample) => sample[1])]);
      setText("gsr-reading", `Raw ${formatNumber(raw.gsr[raw.gsr.length - 1][1])}`);
    }

    if (Array.isArray(raw.imu) && raw.imu.length > 0) {
      const magnitudes = raw.imu.map((sample) => {
        const ax = sample[1] / 16_384;
        const ay = sample[2] / 16_384;
        const az = sample[3] / 16_384;
        return Math.sqrt(ax * ax + ay * ay + az * az);
      });
      appendPoints(charts.imu, sampleTimes(base, raw.imu), [magnitudes]);
      const latest = raw.imu[raw.imu.length - 1];
      const acceleration = latest.slice(1, 4).map((value) => value / 16_384);
      const gyro = latest.slice(4, 7).map((value) => value / 131);
      setText("imu-magnitude", `Magnitude ${magnitudes[magnitudes.length - 1].toFixed(3)} g`);
      setText(
        "imu-reading",
        `Accel ${acceleration.map((value) => value.toFixed(2)).join(" / ")} g · Gyro ${gyro.map((value) => value.toFixed(1)).join(" / ")} °/s`,
      );
    }

    if (Array.isArray(raw.temp) && raw.temp.length > 0) {
      const temperatures = raw.temp.map((sample) => sample[1] * 0.0078125);
      appendPoints(charts.temperature, sampleTimes(base, raw.temp), [temperatures]);
      setText("temperature-reading", `${temperatures[temperatures.length - 1].toFixed(2)} °C`);
    }
  }

  function handleLiveAnalysisUpdate(result) {
    if (
      state.mode !== "live" ||
      !result ||
      result.session_id !== state.activeSessionId ||
      result.epoch_id !== state.currentEpochId
    ) return;
    const windowStartMs = finiteNumber(result.window?.start_ms);
    const windowEndMs = finiteNumber(result.window?.end_ms);
    if (windowStartMs === null || windowEndMs === null || windowEndMs <= windowStartMs) return;
    const key = analysisIdentity(result);
    if (state.liveAnalysisWindows.some((existing) => analysisIdentity(existing) === key)) return;
    state.liveAnalysisWindows.push(result);
    state.liveAnalysisReceivedAt.set(key, Date.now());
    state.liveAnalysisWindows.sort((left, right) =>
      (finiteNumber(left.window?.start_ms) ?? 0) - (finiteNumber(right.window?.start_ms) ?? 0));
    if (state.liveAnalysisWindows.length > MAX_LIVE_ANALYSIS_WINDOWS) {
      const removed = state.liveAnalysisWindows.splice(0, state.liveAnalysisWindows.length - MAX_LIVE_ANALYSIS_WINDOWS);
      removed.forEach((oldResult) => state.liveAnalysisReceivedAt.delete(analysisIdentity(oldResult)));
    }
    state.liveAnalysisResult = result;
    state.liveAnalysisSelectionKey = key;
    state.lastAnalysisWindowEndMs = Math.max(state.lastAnalysisWindowEndMs ?? 0, windowEndMs);
    renderAnalysisResult(result, { mode: "live" });
    renderLiveAnalysisWindows();
    setText("analysis-window-state", `W${windowNumber(result) ?? "—"} complete`);
  }

  function replayDuration() {
    const duration = state.review.manifest?.timeline?.duration_ms;
    return Number.isFinite(duration) ? Math.max(0, duration) : 0;
  }

  function setReplayStatus(message) {
    setText("replay-status", message);
  }

  function setReplayWarning(message) {
    const warning = byId("replay-warning");
    warning.textContent = message;
    warning.hidden = !message;
  }

  function resetReviewSummary() {
    for (const id of [
      "summary-status",
      "summary-device",
      "summary-started",
      "summary-completed",
      "summary-duration",
      "summary-packets",
      "summary-ingestion-gaps",
      "summary-history-gaps",
      "summary-truncated",
      "summary-boundaries",
    ]) setText(id, "—");
    for (const id of [
      "legend-ingestion-count",
      "legend-history-count",
      "legend-reboot-count",
      "legend-epoch-count",
    ]) setText(id, "0");
    byId("timeline-marker-rail").querySelectorAll(".timeline-marker").forEach((marker) => marker.remove());
  }

  function renderReviewSummary(manifest) {
    const session = manifest.session;
    const timeline = manifest.timeline;
    setText("summary-status", session.status);
    setText("summary-device", session.device_id);
    setText("summary-started", formatTime(session.created_at_ms));
    setText("summary-completed", formatTime(session.completed_at_ms));
    setText("summary-duration", formatReplayTime(timeline.duration_ms));
    setText("summary-packets", formatNumber(timeline.packet_count));
    setText(
      "summary-ingestion-gaps",
      `${formatNumber(timeline.ingestion_gap_events)} events · ${formatNumber(timeline.ingestion_missing_packets)} missing`,
    );
    setText(
      "summary-history-gaps",
      `${formatNumber(timeline.history_gap_events)} events · ${formatNumber(timeline.history_missing_packets)} missing`,
    );
    setText("summary-truncated", formatNumber(timeline.truncated_packets));
    setText("summary-boundaries", `${formatNumber(timeline.boot_count)} / ${formatNumber(timeline.epoch_count)}`);
  }

  function addTimelineMarker(type, glyph, replayMs, label, durationMs) {
    const marker = document.createElement("span");
    marker.className = `timeline-marker ${type}`;
    marker.textContent = glyph;
    marker.style.left = `${durationMs > 0 ? Math.max(0, Math.min(100, replayMs / durationMs * 100)) : 0}%`;
    marker.title = `${label} at T+${formatReplayTime(replayMs)}`;
    marker.setAttribute("role", "img");
    marker.setAttribute("aria-label", marker.title);
    marker.tabIndex = 0;
    byId("timeline-marker-rail").appendChild(marker);
  }

  function renderContinuityTimeline(manifest) {
    const timeline = manifest.timeline;
    byId("timeline-marker-rail").querySelectorAll(".timeline-marker").forEach((marker) => marker.remove());
    const duration = timeline.duration_ms;
    for (const gap of Array.isArray(timeline.gaps) ? timeline.gaps : []) {
      const ingestion = gap.type === "ingestion";
      addTimelineMarker(
        ingestion ? "ingestion" : "history",
        ingestion ? "I" : "H",
        gap.replay_ms,
        `${ingestion ? "Ingestion gap" : "Stored-history gap"}: ${gap.missing_packets} missing packets before seq ${gap.seq}`,
        duration,
      );
    }
    let rebootCount = 0;
    let epochBoundaryCount = 0;
    for (const segment of Array.isArray(timeline.segments) ? timeline.segments : []) {
      if (segment.boundary_type === "device_reboot") {
        rebootCount += 1;
        addTimelineMarker("reboot", "R", segment.start_replay_ms, `Device reboot · boot ${shortId(segment.boot_id)}`, duration);
      } else if (segment.boundary_type === "time_epoch") {
        epochBoundaryCount += 1;
        addTimelineMarker("epoch", "E", segment.start_replay_ms, `Time/backend epoch · epoch ${shortId(segment.epoch_id)}`, duration);
      }
    }
    setText("legend-ingestion-count", formatNumber(timeline.ingestion_gap_events));
    setText("legend-history-count", formatNumber(timeline.history_gap_events));
    setText("legend-reboot-count", formatNumber(rebootCount));
    setText("legend-epoch-count", formatNumber(epochBoundaryCount));
  }

  function updateReplayTime() {
    const duration = replayDuration();
    const position = Math.min(state.review.replayPositionMs, duration);
    byId("replay-seek").value = String(position);
    setText("replay-time", `T+${formatReplayTime(position)} / ${formatReplayTime(duration)}`);
    byId("timeline-progress").style.width = `${duration > 0 ? position / duration * 100 : 0}%`;
    const inspection = byId("timeline-inspection");
    if (state.review.inspectionPositionMs === null || duration <= 0) {
      inspection.hidden = true;
    } else {
      inspection.hidden = false;
      inspection.style.left = `${Math.max(0, Math.min(100, state.review.inspectionPositionMs / duration * 100))}%`;
    }
  }

  function setReplayControlsEnabled(enabled) {
    byId("replay-play-button").disabled = !enabled;
    byId("replay-restart-button").disabled = !enabled;
    byId("replay-speed").disabled = !enabled;
    byId("replay-seek").disabled = !enabled;
  }

  function stopReplayAnimation() {
    state.review.playing = false;
    state.review.previousAnimationNow = null;
    if (state.review.animationFrame !== null) {
      cancelAnimationFrame(state.review.animationFrame);
      state.review.animationFrame = null;
    }
    setText("replay-play-button", "Play");
  }

  function replayViewport(position) {
    const duration = replayDuration();
    if (duration <= 0) return { min: 0, max: REPLAY_VIEWPORT_MS };
    if (duration <= REPLAY_VIEWPORT_MS) return { min: 0, max: duration };
    const max = position < REPLAY_VIEWPORT_MS
      ? REPLAY_VIEWPORT_MS
      : Math.min(duration, position);
    return { min: Math.max(0, max - REPLAY_VIEWPORT_MS), max };
  }

  function setReviewScales(viewport) {
    Object.values(charts).forEach((buffer) => {
      buffer.plot.setScale("x", { min: viewport.min, max: viewport.max });
    });
  }

  function requiredReplayChunkIndices(viewport) {
    const duration = replayDuration();
    if (duration <= 0) return [];
    const lastSessionChunk = Math.max(0, Math.ceil(duration / REPLAY_CHUNK_MS) - 1);
    const first = Math.min(lastSessionChunk, Math.floor(viewport.min / REPLAY_CHUNK_MS));
    const lastPoint = Math.max(viewport.min, Math.min(duration, viewport.max) - 0.001);
    const last = Math.min(lastSessionChunk, Math.floor(lastPoint / REPLAY_CHUNK_MS));
    const indices = [];
    for (let index = first; index <= last; index += 1) indices.push(index);
    return indices;
  }

  function evictReplayCache(protectedIndices) {
    while (state.review.cache.size >= MAX_REPLAY_CACHE_CHUNKS) {
      const evictable = Array.from(state.review.cache.keys())
        .find((index) => !protectedIndices.has(index));
      if (evictable === undefined) return false;
      state.review.cache.delete(evictable);
    }
    return true;
  }

  function fetchReplayChunk(index, generation, protectedIndices = new Set([index])) {
    const existing = state.review.cache.get(index);
    if (existing !== undefined) return existing.promise;
    if (!evictReplayCache(protectedIndices)) return Promise.resolve(null);

    const duration = replayDuration();
    const fromMs = index * REPLAY_CHUNK_MS;
    const chunkDurationMs = Math.min(REPLAY_CHUNK_MS, duration - fromMs);
    if (chunkDurationMs <= 0) return Promise.resolve(null);

    const entry = { status: "loading", packets: [], capped: false, promise: null };
    state.review.cache.set(index, entry);
    const sessionId = state.review.sessionId;
    entry.promise = requestJson(
      `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/replay/packets?from_ms=${fromMs}&duration_ms=${chunkDurationMs}`,
    ).then((result) => {
      if (
        generation !== state.review.selectionGeneration ||
        state.mode !== "review" ||
        state.review.cache.get(index) !== entry
      ) return null;
      entry.status = "ready";
      entry.packets = Array.isArray(result.packets) ? result.packets : [];
      entry.capped = result.window?.capped === true;
      return entry;
    }).catch((error) => {
      if (
        generation !== state.review.selectionGeneration ||
        state.mode !== "review" ||
        state.review.cache.get(index) !== entry
      ) return null;
      entry.status = "error";
      entry.error = error;
      throw error;
    });
    return entry.promise;
  }

  function analysisCacheKey(sessionId, fromMs, durationMs) {
    return `${sessionId}|${ANALYSIS_VERSION}|${fromMs}|${durationMs}`;
  }

  function evictAnalysisCache() {
    while (state.review.analysisCache.size >= MAX_REPLAY_CACHE_CHUNKS) {
      const oldestKey = state.review.analysisCache.keys().next().value;
      if (oldestKey === undefined) return false;
      state.review.analysisCache.delete(oldestKey);
    }
    return true;
  }

  function fetchHistoricalAnalysis(sessionId, fromMs, durationMs, generation = state.review.selectionGeneration) {
    const key = analysisCacheKey(sessionId, fromMs, durationMs);
    const existing = state.review.analysisCache.get(key);
    if (existing !== undefined) return existing.promise;
    if (!evictAnalysisCache()) return Promise.resolve(null);

    const entry = {
      key,
      fromMs,
      durationMs,
      status: "loading",
      results: [],
      capped: false,
      promise: null,
    };
    state.review.analysisCache.set(key, entry);
    entry.promise = requestJson(
      `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/analysis?from_ms=${fromMs}&duration_ms=${durationMs}&analysis_version=${encodeURIComponent(ANALYSIS_VERSION)}`,
    ).then((response) => {
      if (
        generation !== state.review.selectionGeneration ||
        state.mode !== "review" ||
        state.review.analysisCache.get(key) !== entry
      ) return null;
      entry.status = "ready";
      entry.results = Array.isArray(response.results) ? response.results : [];
      entry.capped = response.window?.capped === true;
      renderHistoricalAnalysisAtCursor(state.review.inspectionPositionMs ?? state.review.replayPositionMs);
      return entry;
    }).catch((error) => {
      if (
        generation !== state.review.selectionGeneration ||
        state.mode !== "review" ||
        state.review.analysisCache.get(key) !== entry
      ) return null;
      entry.status = "error";
      entry.error = error;
      renderHistoricalAnalysisAtCursor(state.review.inspectionPositionMs ?? state.review.replayPositionMs);
      throw error;
    });
    return entry.promise;
  }

  function ensureHistoricalAnalysis(viewport, requiredIndices, generation) {
    const sessionId = state.review.sessionId;
    if (!sessionId) return;
    const duration = replayDuration();
    const requests = [];
    for (const index of requiredIndices) {
      const fromMs = index * REPLAY_CHUNK_MS;
      const durationMs = Math.min(REPLAY_CHUNK_MS, duration - fromMs);
      if (durationMs <= 0) continue;
      requests.push(fetchHistoricalAnalysis(sessionId, fromMs, durationMs, generation));
    }
    if (requests.length > 0) void Promise.allSettled(requests);
    renderHistoricalAnalysisAtCursor(state.review.inspectionPositionMs ?? state.review.replayPositionMs);
  }

  function cachedHistoricalAnalysisAtCursor(cursorMs) {
    const matches = [];
    for (const entry of state.review.analysisCache.values()) {
      if (entry.status !== "ready") continue;
      for (const envelope of entry.results) {
        const startMs = Number(envelope.replay_start_ms);
        const endMs = Number(envelope.replay_end_ms);
        if (
          Number.isFinite(startMs) &&
          Number.isFinite(endMs) &&
          startMs <= cursorMs &&
          cursorMs < endMs
        ) {
          matches.push({ envelope, startMs, endMs });
        }
      }
    }
    matches.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
    return matches.at(-1) ?? null;
  }

  function cachedHistoricalAnalysisRows() {
    const rowsByKey = new Map();
    for (const entry of state.review.analysisCache.values()) {
      if (entry.status !== "ready") continue;
      for (const envelope of entry.results) {
        const result = envelope?.result;
        if (!result) continue;
        const key = analysisIdentity(result);
        rowsByKey.set(key, { key, envelope });
      }
    }
    return Array.from(rowsByKey.values()).sort((left, right) => {
      const startDifference = (finiteNumber(left.envelope.replay_start_ms) ?? 0) - (finiteNumber(right.envelope.replay_start_ms) ?? 0);
      if (startDifference !== 0) return startDifference;
      return (finiteNumber(left.envelope.replay_end_ms) ?? 0) - (finiteNumber(right.envelope.replay_end_ms) ?? 0);
    });
  }

  function renderReviewAnalysisWindows() {
    const rows = cachedHistoricalAnalysisRows();
    setText("recent-analysis-context", rows.length > 0 ? `${rows.length} completed windows in loaded review chunks` : "Bounded loaded review chunks only");
    setText("analysis-result-received", state.review.selectedAnalysisKey ? "Persisted historical result" : "—");
    renderAnalysisWindowList(rows, {
      selectedKey: state.review.selectedAnalysisKey,
      onSelect: (key, row) => {
        state.review.selectedAnalysisKey = key;
        renderAnalysisResult(row.envelope.result, { mode: "review", envelope: row.envelope });
        renderReviewAnalysisWindows();
      },
    });
  }

  function renderHistoricalAnalysisAtCursor(replayPositionMs) {
    if (state.mode !== "review") return;
    if (replayPositionMs > state.review.replayPositionMs) {
      state.review.selectedAnalysisKey = null;
      renderReviewAnalysisWindows();
      renderAnalysisResult(null, {
        emptyMessage: "Replay has not presented analysis at this cursor position yet.",
      });
      return;
    }
    const selected = cachedHistoricalAnalysisAtCursor(replayPositionMs);
    if (selected?.envelope?.result) {
      state.review.selectedAnalysisKey = analysisIdentity(selected.envelope.result);
      renderReviewAnalysisWindows();
      renderAnalysisResult(selected.envelope.result, {
        mode: "review",
        envelope: selected.envelope,
      });
      return;
    }

    const loading = Array.from(state.review.analysisCache.values()).some((entry) => entry.status === "loading");
    state.review.selectedAnalysisKey = null;
    renderReviewAnalysisWindows();
    renderAnalysisResult(null, {
      emptyMessage: loading ? "Loading historical analysis…" : "Analysis not available for this interval.",
    });
  }

  function cachedReplayPackets(viewport) {
    const deduplicated = new Map();
    for (const entry of state.review.cache.values()) {
      if (entry.status !== "ready") continue;
      for (const packet of entry.packets) {
        const raw = packet.raw_packet;
        if (!raw) continue;
        const endMs = packet.replay_t0_ms + (raw.t1_us - raw.t0_us) / 1_000;
        if (endMs < viewport.min || packet.replay_t0_ms > viewport.max) continue;
        deduplicated.set(`${packet.boot_id}:${packet.seq}`, packet);
      }
    }
    return Array.from(deduplicated.values()).sort((left, right) =>
      left.replay_t0_ms - right.replay_t0_ms ||
      left.received_at_ms - right.received_at_ms ||
      String(left.boot_id).localeCompare(String(right.boot_id)) ||
      left.seq - right.seq);
  }

  function appendHistoricalSamples(data, samples, baseMs, valueMapper, breakPending, limits) {
    if (!Array.isArray(samples) || samples.length === 0) return breakPending;
    const selected = samples.filter((sample) => {
      const sampleReplayMs = baseMs + sample[0] / 1_000;
      return sampleReplayMs >= limits.min && sampleReplayMs <= limits.max;
    });
    if (selected.length === 0) return breakPending;

    const times = selected.map((sample) => baseMs + sample[0] / 1_000);
    if (breakPending && data[0].length > 0) {
      const previousX = data[0][data[0].length - 1];
      const nextX = times[0];
      if (nextX > previousX) {
        data[0].push(previousX + (nextX - previousX) / 2);
        for (let column = 1; column < data.length; column += 1) data[column].push(null);
      }
    }
    data[0].push(...times);
    const columns = valueMapper(selected);
    for (let column = 0; column < columns.length; column += 1) {
      data[column + 1].push(...columns[column]);
    }
    return false;
  }

  function manifestBoundaryForPacket(packet) {
    const segments = state.review.manifest?.timeline?.segments;
    if (!Array.isArray(segments)) return null;
    return segments.find((segment) =>
      segment.boundary_type !== "session_start" &&
      segment.boot_id === packet.boot_id &&
      segment.epoch_id === packet.epoch_id &&
      Math.abs(segment.start_replay_ms - packet.replay_t0_ms) < 0.001) ?? null;
  }

  function latestContinuityBarrierAtOrBefore(position) {
    const timeline = state.review.manifest?.timeline;
    let barrierMs = null;
    for (const gap of Array.isArray(timeline?.gaps) ? timeline.gaps : []) {
      if (gap.replay_ms <= position && (barrierMs === null || gap.replay_ms > barrierMs)) {
        barrierMs = gap.replay_ms;
      }
    }
    for (const segment of Array.isArray(timeline?.segments) ? timeline.segments : []) {
      if (
        segment.boundary_type !== "session_start" &&
        segment.start_replay_ms <= position &&
        (barrierMs === null || segment.start_replay_ms > barrierMs)
      ) {
        barrierMs = segment.start_replay_ms;
      }
    }
    return barrierMs;
  }

  function sampleAtOrBefore(signal, position, viewport, barrierMs) {
    let match = null;
    const continuousStartMs = Math.max(viewport.min, barrierMs ?? viewport.min);
    for (const entry of state.review.cache.values()) {
      if (entry.status !== "ready") continue;
      for (const packet of entry.packets) {
        const samples = packet.raw_packet?.[signal];
        if (!Array.isArray(samples)) continue;
        for (const sample of samples) {
          const sampleReplayMs = packet.replay_t0_ms + sample[0] / 1_000;
          if (
            sampleReplayMs >= continuousStartMs &&
            sampleReplayMs <= position &&
            (match === null || sampleReplayMs > match.replayMs)
          ) {
            match = { sample, replayMs: sampleReplayMs };
          }
        }
      }
    }
    return match;
  }

  function updateInspectionReadings() {
    if (state.mode !== "review" || state.review.manifest === null) return;
    const viewport = replayViewport(state.review.replayPositionMs);
    const requestedPosition = state.review.inspectionPositionMs ?? state.review.replayPositionMs;
    const prefix = state.review.inspectionPositionMs === null ? "Playback" : "Cursor";
    setText("inspection-time", `${prefix} T+${formatReplayTime(requestedPosition)}`);
    for (const id of [
      "inspection-ecg",
      "inspection-ppg",
      "inspection-gsr",
      "inspection-imu",
      "inspection-temperature",
    ]) setText(id, "—");
    resetSignalReadings();

    if (requestedPosition > state.review.replayPositionMs) {
      setText("inspection-policy", "Replay has not presented data at this cursor position yet");
      return;
    }

    const barrierMs = latestContinuityBarrierAtOrBefore(requestedPosition);

    const ecg = sampleAtOrBefore("ecg", requestedPosition, viewport, barrierMs)?.sample ?? null;
    if (ecg !== null) {
      const leads = [];
      if (ecg[2] === 1) leads.push("LO+");
      if (ecg[3] === 1) leads.push("LO−");
      const leadState = leads.length === 0 ? "Leads connected" : `Lead off ${leads.join(" / ")}`;
      setText("ecg-lead-state", leadState);
      setTone(byId("ecg-lead-state"), leads.length === 0 ? "good" : "warn");
      setText("inspection-ecg", `ADC ${formatNumber(ecg[1])} · ${leadState}`);
    }

    const ppg = sampleAtOrBefore("ppg", requestedPosition, viewport, barrierMs)?.sample ?? null;
    if (ppg !== null) {
      const value = `RED ${formatNumber(ppg[1])} · IR ${formatNumber(ppg[2])}`;
      setText("ppg-reading", value);
      setText("inspection-ppg", value);
    }

    const gsr = sampleAtOrBefore("gsr", requestedPosition, viewport, barrierMs)?.sample ?? null;
    if (gsr !== null) {
      const value = `Raw ${formatNumber(gsr[1])}`;
      setText("gsr-reading", value);
      setText("inspection-gsr", value);
    }

    const imu = sampleAtOrBefore("imu", requestedPosition, viewport, barrierMs)?.sample ?? null;
    if (imu !== null) {
      const acceleration = imu.slice(1, 4).map((value) => value / 16_384);
      const gyro = imu.slice(4, 7).map((value) => value / 131);
      const magnitude = Math.sqrt(acceleration.reduce((sum, value) => sum + value * value, 0));
      setText("imu-magnitude", `Magnitude ${magnitude.toFixed(3)} g`);
      setText(
        "imu-reading",
        `Accel ${acceleration.map((value) => value.toFixed(2)).join(" / ")} g · Gyro ${gyro.map((value) => value.toFixed(1)).join(" / ")} °/s`,
      );
      setText("inspection-imu", `${magnitude.toFixed(3)} g`);
    }

    const temperature = sampleAtOrBefore("temp", requestedPosition, viewport, barrierMs)?.sample ?? null;
    if (temperature !== null) {
      const value = `${(temperature[1] * 0.0078125).toFixed(2)} °C`;
      setText("temperature-reading", value);
      setText("inspection-temperature", value);
    }
    setText(
      "inspection-policy",
      [ecg, ppg, gsr, imu, temperature].some((sample) => sample !== null)
        ? "Nearest sample at or before position · no interpolation"
        : barrierMs === null
          ? "No signal samples in the loaded historical view"
          : `No signal samples after continuity boundary at T+${formatReplayTime(barrierMs)}`,
    );
  }

  function handleReviewCursor(plot) {
    if (state.mode !== "review" || state.review.manifest === null || plot.cursor.left < 0) return;
    const position = plot.posToVal(plot.cursor.left, "x");
    if (!Number.isFinite(position)) return;
    state.review.inspectionPositionMs = Math.max(0, Math.min(replayDuration(), position));
    updateReplayTime();
    updateInspectionReadings();
    renderHistoricalAnalysisAtCursor(state.review.inspectionPositionMs);
  }

  function renderHistoricalPackets(viewport) {
    const position = state.review.replayPositionMs;
    const limits = { min: viewport.min, max: Math.min(viewport.max, position) };
    const packets = cachedReplayPackets(viewport);
    const data = {
      ecg: [[], []],
      ppg: [[], [], []],
      gsr: [[], []],
      imu: [[], []],
      temperature: [[], []],
    };
    const breakPending = { ecg: false, ppg: false, gsr: false, imu: false, temperature: false };
    let previousPacket = null;
    let latestBoundaryMessage = null;

    for (const packet of packets) {
      if (packet.replay_t0_ms > position || !packet.raw_packet) continue;
      const reasons = [];
      const manifestBoundary = manifestBoundaryForPacket(packet);
      const bootChanged = previousPacket !== null && packet.boot_id !== previousPacket.boot_id;
      const epochChanged = !bootChanged && previousPacket !== null && packet.epoch_id !== previousPacket.epoch_id;
      if (bootChanged || manifestBoundary?.boundary_type === "device_reboot") reasons.push("Device reboot");
      else if (epochChanged || manifestBoundary?.boundary_type === "time_epoch") reasons.push("Time/backend epoch");
      if (packet.gap_before > 0 || packet.sequence_status === "gap") reasons.push("Ingestion gap");
      if (packet.history_gap_before > 0) reasons.push("Stored-history gap");
      if (reasons.length > 0) {
        Object.keys(breakPending).forEach((key) => { breakPending[key] = true; });
        latestBoundaryMessage = `${reasons.join(" · ")} before seq ${packet.seq}`;
      }

      const raw = packet.raw_packet;
      const base = packet.replay_t0_ms;
      breakPending.ecg = appendHistoricalSamples(
        data.ecg,
        raw.ecg,
        base,
        (samples) => [samples.map((sample) => sample[1])],
        breakPending.ecg,
        limits,
      );
      breakPending.ppg = appendHistoricalSamples(
        data.ppg,
        raw.ppg,
        base,
        (samples) => [samples.map((sample) => sample[1]), samples.map((sample) => sample[2])],
        breakPending.ppg,
        limits,
      );
      breakPending.gsr = appendHistoricalSamples(
        data.gsr,
        raw.gsr,
        base,
        (samples) => [samples.map((sample) => sample[1])],
        breakPending.gsr,
        limits,
      );
      breakPending.imu = appendHistoricalSamples(
        data.imu,
        raw.imu,
        base,
        (samples) => [samples.map((sample) => {
          const ax = sample[1] / 16_384;
          const ay = sample[2] / 16_384;
          const az = sample[3] / 16_384;
          return Math.sqrt(ax * ax + ay * ay + az * az);
        })],
        breakPending.imu,
        limits,
      );
      breakPending.temperature = appendHistoricalSamples(
        data.temperature,
        raw.temp,
        base,
        (samples) => [samples.map((sample) => sample[1] * 0.0078125)],
        breakPending.temperature,
        limits,
      );

      previousPacket = packet;
    }

    for (const [name, buffer] of Object.entries(charts)) {
      buffer.plot.setData(data[name], false);
      buffer.plot.setScale("x", { min: viewport.min, max: viewport.max });
    }

    updateInspectionReadings();
    setText(
      "epoch-state",
      latestBoundaryMessage ?? (previousPacket ? `Review epoch ${shortId(previousPacket.epoch_id)}` : "No replay samples in view"),
    );
  }

  function updateReplayPresentation() {
    if (state.mode !== "review" || state.review.manifest === null) return;
    updateReplayTime();
    const viewport = replayViewport(state.review.replayPositionMs);
    const requiredIndices = requiredReplayChunkIndices(viewport);
    const generation = state.review.selectionGeneration;
    const requiredSet = new Set(requiredIndices);
    ensureHistoricalAnalysis(viewport, requiredIndices, generation);
    const missingIndices = requiredIndices.filter((index) => !state.review.cache.has(index));
    const loadingEntries = requiredIndices
      .map((index) => state.review.cache.get(index))
      .filter((entry) => entry?.status === "loading");
    const failedEntry = requiredIndices
      .map((index) => state.review.cache.get(index))
      .find((entry) => entry?.status === "error");

    if (failedEntry !== undefined) {
      stopReplayAnimation();
      setReplayStatus("Replay packet window failed to load.");
      showError(`Unable to load replay packets: ${failedEntry.error.message}`, "replay");
      return;
    }
    if (missingIndices.length > 0 || loadingEntries.length > 0) {
      stopReplayAnimation();
      setReviewScales(viewport);
      setReplayStatus("Loading replay data…");
      const requests = missingIndices.map((index) => fetchReplayChunk(index, generation, requiredSet));
      Promise.all([...requests, ...loadingEntries.map((entry) => entry.promise)])
        .then(() => {
          if (generation === state.review.selectionGeneration && state.mode === "review") {
            clearError("replay");
            updateReplayPresentation();
          }
        })
        .catch(() => updateReplayPresentation());
      return;
    }

    renderHistoricalPackets(viewport);
    const capped = Array.from(state.review.cache.values()).some((entry) => entry.capped);
    setReplayWarning(capped ? "A replay packet window reached the 1000-packet cap; that interval may be incomplete." : "");
    setReplayStatus(state.review.playing ? `Playing at ${state.review.replaySpeed}×` : "Replay paused");

    const lastSessionChunk = Math.max(0, Math.ceil(replayDuration() / REPLAY_CHUNK_MS) - 1);
    const nextIndex = Math.max(...requiredIndices) + 1;
    const previousIndex = Math.min(...requiredIndices) - 1;
    const prefetchIndex = nextIndex <= lastSessionChunk ? nextIndex : previousIndex >= 0 ? previousIndex : null;
    if (prefetchIndex !== null && !state.review.cache.has(prefetchIndex)) {
      void fetchReplayChunk(prefetchIndex, generation, requiredSet).catch(() => undefined);
    }
  }

  function setReplayPosition(positionMs) {
    state.review.replayPositionMs = Math.max(0, Math.min(replayDuration(), positionMs));
    state.review.inspectionPositionMs = null;
    state.review.previousAnimationNow = null;
    updateReplayPresentation();
  }

  function replayAnimationFrame(animationNow) {
    state.review.animationFrame = null;
    if (state.mode !== "review" || !state.review.playing) return;
    if (state.review.previousAnimationNow !== null) {
      const elapsedRealMs = Math.max(0, animationNow - state.review.previousAnimationNow);
      state.review.replayPositionMs = Math.min(
        replayDuration(),
        state.review.replayPositionMs + elapsedRealMs * state.review.replaySpeed,
      );
    }
    state.review.previousAnimationNow = animationNow;
    if (state.review.replayPositionMs >= replayDuration()) stopReplayAnimation();
    updateReplayPresentation();
    if (state.review.playing) {
      state.review.animationFrame = requestAnimationFrame(replayAnimationFrame);
    } else if (state.review.replayPositionMs >= replayDuration()) {
      setReplayStatus("Replay complete");
    }
  }

  function startReplayAnimation() {
    if (state.review.manifest === null || replayDuration() <= 0) return;
    if (state.review.replayPositionMs >= replayDuration()) state.review.replayPositionMs = 0;
    state.review.playing = true;
    state.review.previousAnimationNow = null;
    setText("replay-play-button", "Pause");
    state.review.animationFrame = requestAnimationFrame(replayAnimationFrame);
  }

  async function loadReplaySession(sessionId) {
    const generation = state.review.selectionGeneration + 1;
    state.review.selectionGeneration = generation;
    stopReplayAnimation();
    state.review.sessionId = sessionId || null;
    updateReviewedSessionHighlight();
    state.review.manifest = null;
    state.review.replayPositionMs = 0;
    state.review.replaySpeed = 1;
    state.review.inspectionPositionMs = null;
    state.review.selectedAnalysisKey = null;
    state.review.cache.clear();
    state.review.analysisCache.clear();
    renderReviewAnalysisWindows();
    byId("replay-speed").value = "1";
    byId("replay-seek").max = "0";
    setReplayControlsEnabled(false);
    setReplayWarning("");
    resetReviewSummary();
    clearSignalState();
    for (const id of [
      "inspection-ecg",
      "inspection-ppg",
      "inspection-gsr",
      "inspection-imu",
      "inspection-temperature",
    ]) setText(id, "—");
    setText("inspection-time", "Playback T+00:00.000");
    setText("inspection-policy", "Waiting for replay samples");
    updateReplayTime();
    setText("review-session-detail", sessionId || "No session selected");
    byId("review-session-detail").title = sessionId || "";

    if (!sessionId) {
      state.finalAnalysisSessionId = null;
      state.finalAnalysisLoadedSessionId = null;
      renderFinalAnalysisState({ state: "unavailable" }, null, { mode: "review" });
      setReplayStatus("Select a persisted session to review.");
      return;
    }

    state.finalAnalysisSessionId = sessionId;
    state.finalAnalysisLoadedSessionId = null;
    renderFinalAnalysisState({ state: "pending" }, sessionId, { mode: "review", loading: true });
    void refreshFinalAnalysis(sessionId, { mode: "review", generation, loading: true });
    setReplayStatus("Loading replay manifest…");
    try {
      const result = await requestJson(
        `${API_BASE}/sessions/${encodeURIComponent(sessionId)}/replay`,
      );
      if (generation !== state.review.selectionGeneration || state.mode !== "review") return;
      state.review.manifest = result;
      const duration = replayDuration();
      byId("replay-seek").max = String(duration);
      renderReviewSummary(result);
      renderContinuityTimeline(result);
      updateReplayTime();
      clearError("replay");
      if (duration <= 0 || result.timeline?.packet_count === 0) {
        setReplayStatus("This session has no persisted packets to replay.");
        setReviewScales(replayViewport(0));
        return;
      }
      setReplayControlsEnabled(true);
      updateReplayPresentation();
    } catch (error) {
      if (generation !== state.review.selectionGeneration || state.mode !== "review") return;
      setReplayStatus("Replay manifest unavailable.");
      showError(`Unable to load replay manifest: ${error.message}`, "replay");
    }
  }

  function applyReviewFocus() {
    const focus = state.mode === "review" ? state.review.focusSignal : "all";
    byId("chart-grid").dataset.focus = focus;
    document.querySelectorAll(".chart-panel[data-signal]").forEach((panel) => {
      panel.hidden = focus !== "all" && panel.dataset.signal !== focus;
    });
    byId("review-focus-controls").querySelectorAll("button[data-focus]").forEach((button) => {
      const selected = button.dataset.focus === focus;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });
    requestAnimationFrame(() => {
      for (const [name, buffer] of Object.entries(charts)) {
        if (focus !== "all" && focus !== name) continue;
        const width = Math.floor(buffer.element.clientWidth);
        if (width > 0) buffer.plot.setSize({ width, height: focus === "all" ? 220 : 340 });
        buffer.plot.syncRect();
      }
    });
  }

  function setReviewFocus(focus) {
    if (!["all", "ecg", "ppg", "gsr", "imu", "temperature"].includes(focus)) return;
    state.review.focusSignal = focus;
    applyReviewFocus();
  }

  function renderDemoScenarios() {
    const container = byId("demo-scenarios");
    container.replaceChildren();
    if (state.demo.scenarios.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No demonstration scenarios are available.";
      container.appendChild(empty);
      return;
    }
    for (const scenario of state.demo.scenarios) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "demo-scenario-card";
      card.dataset.scenarioId = scenario.id;
      card.classList.toggle("selected", state.demo.selectedScenarioId === scenario.id);
      card.disabled = state.actionPending;
      const heading = document.createElement("h3");
      heading.textContent = scenario.title;
      const description = document.createElement("p");
      description.textContent = scenario.description;
      const expected = document.createElement("small");
      expected.textContent = `Expected: ${scenario.expected_pattern} · ${scenario.expected_rule_ids.join(", ")} · ${scenario.expected_evidence_tier}`;
      card.append(heading, description, expected);
      card.addEventListener("click", () => startDemoScenario(scenario.id));
      container.appendChild(card);
    }
  }

  async function refreshDemoScenarios() {
    if (!DEMO_MODE || state.demo.loadingScenarios) return;
    state.demo.loadingScenarios = true;
    try {
      const response = await requestJson(`${API_BASE}/scenarios`);
      state.demo.scenarios = Array.isArray(response?.scenarios) ? response.scenarios : [];
      renderDemoScenarios();
      clearError("demo-scenarios");
    } catch (error) {
      showError(`Unable to load demonstration scenarios: ${error.message}`, "demo-scenarios");
    } finally {
      state.demo.loadingScenarios = false;
    }
  }

  function startDemoScenario(scenarioId) {
    if (!DEMO_MODE || state.actionPending) return;
    state.demo.selectedScenarioId = scenarioId;
    state.demo.guardTriggered = false;
    closeLiveSocket();
    clearSignalState();
    renderDemoScenarios();
    runSessionAction(() => requestJson(`${API_BASE}/start`, {
      method: "POST",
      body: JSON.stringify({ scenario_id: scenarioId }),
    }));
  }

  function stopDemo() {
    if (!DEMO_MODE || state.actionPending) return;
    runSessionAction(() => requestJson(`${API_BASE}/stop`, {
      method: "POST",
      body: JSON.stringify({ session_id: state.activeSessionId }),
    }));
  }

  function renderDemoStatus(status) {
    const demo = status.demo ?? {};
    state.demo.status = demo;
    if (demo.scenario?.id) state.demo.selectedScenarioId = demo.scenario.id;
    setText("demo-phase", demo.phase ?? "IDLE");
    const elapsed = finiteNumber(demo.visible_elapsed_ms) ?? 0;
    const duration = finiteNumber(demo.visible_duration_ms) ?? 30_000;
    const packetCount = finiteNumber(demo.visible_packet_count) ?? 0;
    const windowCount = finiteNumber(demo.visible_analysis_window_count) ?? 0;
    const scenarioTitle = demo.scenario?.title ?? "No scenario selected";
    const phaseText = demo.phase === "PREPARING"
      ? `${scenarioTitle} · preparing hidden baseline and priming data`
      : demo.phase === "STREAMING"
        ? `${scenarioTitle} · streaming simulated source · T+${formatReplayTime(elapsed)} / ${formatReplayTime(duration)} · ${formatNumber(packetCount)} packets · ${formatNumber(windowCount)} windows`
        : demo.phase === "FINALIZING"
          ? `${scenarioTitle} · finalizing visible windows`
          : demo.phase === "COMPLETE"
            ? `${scenarioTitle} · complete · ${formatNumber(windowCount)} visible windows`
            : demo.phase === "ERROR"
              ? `${scenarioTitle} · stopped with an isolated demo error`
              : "Select a scenario to begin.";
    setText("demo-runtime-status", phaseText);
    const validationState = demo.validation_state ?? "pending";
    const validationText = validationState === "passed"
      ? "Validation passed"
      : validationState === "failed"
        ? `Validation failed${demo.validation_message ? ` · ${demo.validation_message}` : ""}`
        : demo.baseline_ready === true ? "Baseline ready · validation pending" : "Validation pending";
    setText("demo-validation-status", validationText);
    setTone(byId("demo-validation-status"), validationState === "passed" ? "good" : validationState === "failed" ? "bad" : "warn");
    byId("demo-stop-button").disabled = !["PREPARING", "STREAMING"].includes(demo.phase) || state.actionPending;
    renderDemoScenarios();

    const forbidden = demo.latest_pattern === "Insufficient evidence for multimodal interpretation" ||
      (Array.isArray(demo.latest_rule_ids) && demo.latest_rule_ids.includes("MM-07"));
    if (forbidden && demo.phase !== "ERROR" && !state.demo.guardTriggered) {
      state.demo.guardTriggered = true;
      showError("The demonstration guard stopped a visible insufficient-evidence result.", "demo-guard");
      void requestJson(`${API_BASE}/stop`, {
        method: "POST",
        body: JSON.stringify({ session_id: state.activeSessionId }),
      }).catch(() => undefined);
    }
    if (!forbidden && demo.phase === "PREPARING") state.demo.guardTriggered = false;
  }

  function applyModePresentation() {
    const reviewing = state.mode === "review";
    document.body.dataset.mode = state.mode;
    document.body.dataset.demo = String(DEMO_MODE);
    byId("demo-banner").hidden = !DEMO_MODE;
    byId("demo-scenario-panel").hidden = !DEMO_MODE;
    byId("demo-nav-button").hidden = DEMO_MODE;
    byId("return-live-button").hidden = !DEMO_MODE;
    byId("live-mode-button").classList.toggle("active", !reviewing);
    byId("review-mode-button").classList.toggle("active", reviewing);
    byId("live-mode-button").setAttribute("aria-pressed", String(!reviewing));
    byId("review-mode-button").setAttribute("aria-pressed", String(reviewing));
    byId("review-controls").hidden = !reviewing;
    byId("review-focus-controls").hidden = !reviewing;
    byId("inspection-panel").hidden = !reviewing;
    setText("dashboard-title", DEMO_MODE
      ? (reviewing ? "Objective monitoring · demonstration review" : "Objective monitoring · simulated demonstration")
      : (reviewing ? "Clinician historical review" : "Clinician monitoring"));
    setText(
      "dashboard-subtitle",
      DEMO_MODE
        ? "Deterministic synthetic sensor data · isolated from live hardware and patient data"
        : reviewing ? "Persisted raw sensor replay · live monitoring continues independently" : "Live raw sensor streams and operational health",
    );
    setText("signals-kicker", DEMO_MODE
      ? (reviewing ? "Synthetic signals · REVIEW" : "Synthetic signals · LIVE")
      : (reviewing ? "Historical signals · REVIEW" : "Live signals · LIVE"));
    setText(
      "signals-description",
      reviewing
        ? "Session-relative time · synchronized 30 second viewport · no filtering or interpretation"
        : "ESP-relative time · rolling windows · no filtering or interpretation",
    );
    const chartContexts = reviewing
      ? {
          ecg: "Raw ADC · shared 30 second viewport",
          ppg: "Raw RED and IR · shared 30 second viewport",
          gsr: "Raw sensor trend · shared 30 second viewport",
          imu: "Acceleration magnitude · shared 30 second viewport",
          temperature: "Display conversion · shared 30 second viewport",
        }
      : {
          ecg: "Raw ADC · 10 second window",
          ppg: "Raw RED and IR · 10 second window",
          gsr: "Raw sensor trend · 30 second window",
          imu: "Acceleration magnitude · 10 second window",
          temperature: "Display conversion · 60 second window",
        };
    Object.entries(chartContexts).forEach(([name, text]) => setText(`${name}-context`, text));
    const historyKicker = document.querySelector(".history-panel .section-kicker");
    if (historyKicker) historyKicker.textContent = DEMO_MODE ? "In-memory demonstration history" : "Durable history";
    setText("history-heading", DEMO_MODE ? "Demonstration sessions" : "Recent sessions");
    setText("final-analysis-kicker", DEMO_MODE ? "Scenario-phase final synthesis · SIMULATED" : "Final session synthesis");
    setText("final-analysis-title", DEMO_MODE ? "Simulated demonstration engineering observations" : "Session-wide engineering observations");
    const historyNote = document.querySelector(".history-note");
    if (historyNote) historyNote.textContent = DEMO_MODE
      ? "Select REVIEW above to inspect this bounded in-memory synthetic replay; it never affects live monitoring."
      : "Select REVIEW above to inspect persisted raw waveform history without affecting live monitoring.";
    const controlNote = document.querySelector(".control-note");
    if (controlNote && DEMO_MODE) controlNote.textContent = "This view is isolated from the live device, accepted-packet bus, database, and patient data.";
    applyReviewFocus();
    updateReviewedSessionHighlight();
    if (state.status) applyStatus(state.status);
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    state.mode = mode;
    if (mode === "review") {
      closeLiveSocket();
      clearSignalState();
      updateLiveBadge("Live socket paused for review", "neutral");
    } else {
      state.review.selectionGeneration += 1;
      stopReplayAnimation();
      state.review.sessionId = null;
      state.review.manifest = null;
      state.review.inspectionPositionMs = null;
      state.review.focusSignal = "all";
      state.review.selectedAnalysisKey = null;
      state.review.cache.clear();
      state.review.analysisCache.clear();
      setReplayWarning("");
      clearError("replay");
      clearSignalState();
      state.finalAnalysisSessionId = null;
      state.finalAnalysisLoadedSessionId = null;
      renderFinalAnalysisState({ state: "unavailable" }, null, { mode: "live" });
    }
    applyModePresentation();
    if (mode === "review") {
      void loadReplaySession(byId("review-session-select").value);
    } else if (state.activeSessionId) {
      renderLiveAnalysisWindows();
      ensureLiveSocket(state.activeSessionId);
    } else {
      renderLiveAnalysisWindows();
    }
  }

  function updateLiveBadge(stateText, tone) {
    setBadge("live-badge", stateText, tone);
  }

  function closeLiveSocket() {
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    const webSocket = state.liveSocket;
    state.liveSocket = null;
    state.socketSessionId = null;
    if (state.mode === "live") clearLiveAnalysis(false, false);
    if (webSocket !== null) webSocket.close();
    updateLiveBadge("Live socket idle", "neutral");
  }

  function ensureLiveSocket(sessionId) {
    if (state.mode !== "live" || !sessionId) return;
    if (state.reconnectTimer !== null) return;
    if (
      state.socketSessionId === sessionId &&
      state.liveSocket !== null &&
      (state.liveSocket.readyState === WebSocket.OPEN || state.liveSocket.readyState === WebSocket.CONNECTING)
    ) return;

    closeLiveSocket();
    const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${scheme}//${window.location.host}${LIVE_WS_BASE}/${encodeURIComponent(sessionId)}`;
    const webSocket = new WebSocket(url);
    state.liveSocket = webSocket;
    state.socketSessionId = sessionId;
    updateLiveBadge("Live socket connecting", "warn");

    webSocket.addEventListener("open", () => {
      if (state.liveSocket === webSocket) updateLiveBadge("Live socket connected", "good");
    });
    webSocket.addEventListener("message", (event) => {
      if (state.liveSocket !== webSocket) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === "ready" && message.session_id === sessionId) {
          clearError("live");
          updateLiveBadge("Live socket ready", "good");
        } else if (message.type === "packet") {
          processAcceptedPacket(message.packet);
        } else if (message.type === "analysis_update") {
          handleLiveAnalysisUpdate(message.result);
        }
      } catch {
        showError("The live stream sent an unreadable message.", "live");
      }
    });
    webSocket.addEventListener("error", () => {
      if (state.liveSocket === webSocket) showError("Live stream connection interrupted; retrying shortly.", "live");
    });
    webSocket.addEventListener("close", () => {
      if (state.liveSocket !== webSocket) return;
      state.liveSocket = null;
      state.socketSessionId = null;
      clearLiveAnalysis(false, false);
      updateLiveBadge("Live socket disconnected", "warn");
      if (state.mode === "live" && state.activeSessionId === sessionId && state.reconnectTimer === null) {
        state.reconnectTimer = window.setTimeout(() => {
          state.reconnectTimer = null;
          if (state.mode === "live" && state.activeSessionId === sessionId) ensureLiveSocket(sessionId);
        }, LIVE_RECONNECT_MS);
      }
    });
  }

  function updatePacketRate(status) {
    const now = performance.now();
    const accepted = status.ingestion.accepted_packets;
    if (state.previousRateSample !== null) {
      const elapsedSeconds = (now - state.previousRateSample.at) / 1_000;
      const delta = accepted - state.previousRateSample.accepted;
      const rate = elapsedSeconds > 0 && delta >= 0 ? delta / elapsedSeconds : 0;
      setText("packet-rate", `${rate.toFixed(1)} packets/s`);
    }
    state.previousRateSample = { accepted, at: now };
  }

  function renderAnalysisActivity(status, session) {
    const analysis = status.analysis ?? {};
    const activityHealth = byId("analysis-activity-health");
    if (state.mode === "review") {
      setText("analysis-activity-state", "Historical review selected");
      setText("analysis-collection-window", "Live collection paused in REVIEW");
      setText("analysis-collection-progress", "—");
      setText("analysis-latest-completed", "Use the selected review window");
      setText("analysis-baseline-state", "Shown per completed window");
      setText("analysis-worker-state", "Live worker not shown");
      setText("analysis-latest-sample", "—");
      setText("analysis-result-received", state.review.selectedAnalysisKey ? "Persisted historical result" : "—");
      byId("analysis-progress-bar").style.width = "0%";
      setText("analysis-activity-health", "REVIEW MODE");
      setTone(activityHealth, "neutral");
      return;
    }

    const collection = analysis.collection;
    const collectionBelongsToSession = collection !== null && collection !== undefined &&
      (session === null || collection.session_id === session.session_id);
    const finalState = analysis.final_analysis?.state;
    if (session === null && finalState === "pending") {
      setText("analysis-activity-state", "Finalizing session analysis");
      setText("analysis-collection-window", "Completed windows draining");
      setText("analysis-collection-progress", "No new window collection");
      setText("analysis-latest-completed", "Awaiting final synthesis");
      setText("analysis-baseline-state", "Final state pending");
      setText("analysis-worker-state", `${formatNumber(analysis.pending_analysis_windows ?? analysis.queue_depth)} pending`);
      setText("analysis-latest-sample", "—");
      setText("analysis-result-received", "—");
      byId("analysis-progress-bar").style.width = "100%";
      setText("analysis-activity-health", "FINALIZING");
      setTone(activityHealth, "warn");
      return;
    }
    if (!session || !collectionBelongsToSession) {
      setText("analysis-activity-state", "Waiting for an active session");
      setText("analysis-collection-window", "No active collection");
      setText("analysis-collection-progress", "—");
      setText("analysis-latest-completed", finalState === "complete" ? "Final synthesis ready" : "—");
      setText("analysis-baseline-state", "—");
      setText("analysis-worker-state", "—");
      setText("analysis-latest-sample", "—");
      setText("analysis-result-received", "—");
      byId("analysis-progress-bar").style.width = "0%";
      setText("analysis-activity-health", finalState === "complete" ? "FINAL SYNTHESIS READY" : "NO ACTIVE ANALYSIS");
      setTone(activityHealth, finalState === "complete" ? "good" : "neutral");
      return;
    }

    const start = finiteNumber(collection.collecting_window_start_ms);
    const end = finiteNumber(collection.collecting_window_end_ms);
    const progress = finiteNumber(collection.progress_ms) ?? 0;
    const fraction = finiteNumber(collection.progress_fraction) ?? 0;
    const collectingNumber = start === null ? null : Math.max(1, Math.floor(start / 10_000) + 1);
    const lastWindow = analysis.last_window?.session_id === collection.session_id &&
      analysis.last_window?.epoch_id === collection.epoch_id
      ? analysis.last_window
      : null;
    const lastNumber = finiteNumber(lastWindow?.start_ms) === null
      ? null
      : Math.max(1, Math.floor(Number(lastWindow.start_ms) / 10_000) + 1);
    const pendingWindows = Math.max(0, Math.floor(finiteNumber(analysis.pending_analysis_windows ?? analysis.queue_depth) ?? 0));
    const collectionLabel = collectingNumber === null ? "Collecting analysis window" : `Collecting W${collectingNumber}`;
    setText("analysis-activity-state", pendingWindows > 0
      ? `${collectionLabel} · analysing ${pendingWindows} completed window${pendingWindows === 1 ? "" : "s"}`
      : collectionLabel);
    setText("analysis-collection-window", start === null || end === null
      ? "Window boundary unavailable"
      : `T+${formatReplayTime(start)} → T+${formatReplayTime(end)}`);
    setText("analysis-collection-progress", `${(progress / 1_000).toFixed(1)} / ${((finiteNumber(collection.window_duration_ms) ?? 10_000) / 1_000).toFixed(1)} s · ${formatPercent(fraction)}`);
    setText("analysis-latest-completed", lastWindow === null
      ? "None yet"
      : `W${lastNumber} · T+${formatReplayTime(Number(lastWindow.start_ms))} → T+${formatReplayTime(Number(lastWindow.end_ms))}`);
    const readyModalities = Array.isArray(analysis.baseline?.ready_modalities) ? analysis.baseline.ready_modalities : [];
    setText("analysis-baseline-state", `${analysis.baseline?.collection_complete === true ? "Complete" : "Building"} · ${readyModalities.length}/5 ready`);
    setText("analysis-worker-state", `${formatNumber(analysis.pending_analysis_windows ?? analysis.queue_depth)} pending · ${formatNumber(analysis.analysis_queue_drops ?? analysis.queue_drops)} dropped`);
    const latestSample = finiteNumber(collection.latest_sample_ms);
    setText("analysis-latest-sample", latestSample === null ? "No sample yet" : `T+${formatReplayTime(latestSample)}`);
    const receivedAt = state.liveAnalysisReceivedAt.get(state.liveAnalysisSelectionKey);
    setText("analysis-result-received", receivedAt === undefined ? "Not received in this browser" : formatTime(receivedAt));
    byId("analysis-progress-bar").style.width = `${Math.max(0, Math.min(100, fraction * 100))}%`;
    const healthy = analysis.pipeline_healthy !== false && analysis.degraded !== true;
    setText("analysis-activity-health", healthy
      ? pendingWindows > 0 ? "ANALYSING + COLLECTING" : "ANALYSIS HEALTHY"
      : "ANALYSIS DEGRADED");
    setTone(activityHealth, healthy ? "good" : "bad");
  }

  function applyStatus(status) {
    state.status = status;
    state.configuredDeviceId = status.configured_device_id;
    setText("configured-device", status.configured_device_id);

    setBadge(
      "device-badge",
      status.device.connected ? "Device connected" : "Device disconnected",
      status.device.connected ? "good" : "bad",
    );

    const session = status.session;
    const nextSessionId = session?.session_id ?? null;
    if (nextSessionId !== state.activeSessionId) {
      const previousSessionId = state.activeSessionId;
      if (state.mode === "live") {
        closeLiveSocket();
        clearLiveAnalysis();
        clearSignalState();
      } else {
        const liveResultSessionId = state.liveAnalysisResult?.session_id ??
          state.liveAnalysisWindows.at(-1)?.session_id ?? null;
        if (liveResultSessionId !== nextSessionId) {
          clearLiveAnalysis(false);
          renderReviewAnalysisWindows();
        }
      }
      state.activeSessionId = nextSessionId;
      if (state.mode === "live" && nextSessionId === null && previousSessionId !== null) {
        state.finalAnalysisSessionId = previousSessionId;
        state.finalAnalysisLoadedSessionId = null;
        void refreshFinalAnalysis(previousSessionId, { mode: "live" });
      } else if (state.mode === "live" && nextSessionId !== null) {
        state.finalAnalysisSessionId = nextSessionId;
        state.finalAnalysisLoadedSessionId = null;
        renderFinalAnalysisState({ state: "unavailable" }, nextSessionId, { mode: "live" });
      }
    }

    if (session === null) {
      setBadge("session-badge", "No active session", "neutral");
      setText("session-state", "IDLE");
      setTone(byId("session-state"), "neutral");
      setText("session-id", "—");
      setText("session-created", "—");
    } else {
      const tone = session.status === "LIVE" ? "good" : "warn";
      setBadge("session-badge", `Session ${session.status}`, tone);
      setText("session-state", session.status);
      setTone(byId("session-state"), tone);
      setText("session-id", session.session_id);
      byId("session-id").title = session.session_id;
      setText("session-created", formatTime(session.created_at_ms));
      if (state.mode === "live") ensureLiveSocket(session.session_id);
    }
    if (state.mode === "review") updateLiveBadge("Live socket paused for review", "neutral");

    setBadge(
      "storage-badge",
      status.storage.healthy ? "Storage healthy" : "Storage degraded",
      status.storage.healthy ? "good" : "bad",
    );

    setText("accepted-packets", formatNumber(status.ingestion.accepted_packets));
    setText("latest-sequence", status.ingestion.latest_sequence ?? "—");
    setText("sequence-gaps", formatNumber(status.ingestion.sequence_gaps));
    setText(
      "invalid-duplicates",
      `${formatNumber(status.ingestion.invalid_packets)} / ${formatNumber(status.ingestion.duplicate_packets)}`,
    );
    setText(
      "acks-reconnects",
      `${formatNumber(status.ingestion.acknowledgements)} / ${formatNumber(status.ingestion.reconnects)}`,
    );
    setText(
      "live-health",
      `${formatNumber(status.live.connected_clients)} / ${formatNumber(status.live.dropped_packets)}`,
    );
    setText(
      "analysis-delivery",
      `${formatNumber(status.live.delivered_analysis)} delivered / ${formatNumber(status.live.dropped_analysis)} dropped`,
    );
    setText("storage-queue", formatNumber(status.storage.queue_depth));
    setText("persisted-packets", formatNumber(status.storage.persisted_packets));
    setText(
      "storage-errors",
      `${formatNumber(status.storage.storage_errors)} / ${formatNumber(status.storage.storage_drops)}`,
    );
    const analysis = status.analysis ?? {};
    const collection = analysis.collection;
    const collectionStart = finiteNumber(collection?.collecting_window_start_ms);
    const collectionNumber = collectionStart === null ? null : Math.max(1, Math.floor(collectionStart / 10_000) + 1);
    setText("analysis-window-state", session !== null && collectionNumber !== null
      ? `Collecting W${collectionNumber}`
      : session === null && analysis.final_analysis?.state === "pending"
        ? "Finalizing"
        : session === null && analysis.final_analysis?.state === "complete"
          ? "Final synthesis ready"
          : "No active analysis");
    setText(
      "analysis-queue",
      `${formatNumber(analysis.pending_analysis_windows ?? analysis.queue_depth)} pending · ${formatNumber(analysis.analysis_queue_drops ?? analysis.queue_drops)} drops`,
    );
    setText(
      "analysis-runtime-metrics",
      `complete ${formatNumber(analysis.completed_windows_emitted ?? analysis.windows_emitted)} · failed ${formatNumber(analysis.windows_failed)} · input errors ${formatNumber(analysis.packet_processing_failures)} · wait ${formatNumber(analysis.last_analysis_queue_wait_ms)} ms · run ${formatNumber(analysis.last_analysis_duration_ms)} ms`,
    );
    const analysisHealthy = analysis.pipeline_healthy !== false && analysis.degraded !== true;
    setText("analysis-health", analysisHealthy ? "Healthy" : "Degraded");
    setTone(byId("analysis-health"), analysisHealthy ? "good" : "bad");
    const analysisStorageHealthy = analysis.storage_healthy !== false;
    setText(
      "analysis-storage-health",
      `${analysisStorageHealthy ? "Healthy" : "Degraded"} · q ${formatNumber(analysis.analysis_result_storage_queue_depth ?? analysis.storage_queue_depth)} · errors ${formatNumber(analysis.analysis_result_storage_errors ?? analysis.storage_errors)} · drops ${formatNumber(analysis.analysis_result_storage_drops ?? analysis.storage_drops)} · final ${analysis.final_analysis?.state ?? "—"}`,
    );
    setTone(byId("analysis-storage-health"), analysisStorageHealthy ? "good" : "bad");
    renderAnalysisActivity(status, session);
    if (state.mode === "live" && analysis.final_analysis?.session_id &&
      (state.activeSessionId === null || analysis.final_analysis.session_id === state.activeSessionId)) {
      state.finalAnalysisSessionId = analysis.final_analysis.session_id;
      renderFinalAnalysisState(analysis.final_analysis, state.finalAnalysisSessionId, { mode: "live" });
      if (
        analysis.final_analysis.state === "complete" &&
        state.activeSessionId === null &&
        state.finalAnalysisLoadedSessionId !== state.finalAnalysisSessionId &&
        !state.finalAnalysisFetchPending
      ) {
        void refreshFinalAnalysis(state.finalAnalysisSessionId, { mode: "live" });
      }
    } else if (state.mode === "live" && session !== null) {
      renderFinalAnalysisState({ state: "unavailable" }, session.session_id, { mode: "live" });
    }
    updatePacketRate(status);

    byId("start-button").disabled =
      state.mode !== "live" || state.actionPending || session !== null || !state.configuredDeviceId;
    byId("stop-button").disabled = state.mode !== "live" || state.actionPending || session === null;
    if (DEMO_MODE) {
      const demo = status.demo ?? {};
      const sourceActive = ["PREPARING", "STREAMING", "FINALIZING"].includes(demo.phase);
      const sourceLabel = sourceActive ? "Simulated source active" : demo.phase === "COMPLETE" ? "Simulated source complete" : "Simulated source idle";
      setBadge("device-badge", sourceLabel, sourceActive ? "good" : demo.phase === "COMPLETE" ? "warn" : "neutral");
      setBadge("storage-badge", "Demo memory only", "good");
      if (session !== null) {
        setBadge("session-badge", `Demo ${session.status}`, session.status === "ERROR" ? "bad" : session.status === "COMPLETED" ? "warn" : "good");
      }
      renderDemoStatus(status);
    }
  }

  async function requestJson(url, options) {
    const response = await fetch(url, {
      headers: { "content-type": "application/json" },
      ...options,
    });
    let body = null;
    try { body = await response.json(); } catch { /* The status code still describes failure. */ }
    if (!response.ok) {
      throw new Error(body?.error ?? `Request failed with status ${response.status}`);
    }
    return body;
  }

  async function refreshStatus() {
    if (state.statusRefreshing) return;
    state.statusRefreshing = true;
    try {
      applyStatus(await requestJson(`${API_BASE}/status`));
      clearError("status");
    } catch (error) {
      showError(`Unable to refresh monitoring status: ${error.message}`, "status");
    } finally {
      state.statusRefreshing = false;
    }
  }

  function appendHistoryCell(row, value, className) {
    const cell = document.createElement("td");
    cell.textContent = value;
    if (className) cell.className = className;
    row.appendChild(cell);
    return cell;
  }

  function updateReviewSessionOptions(sessions) {
    const select = byId("review-session-select");
    const previousSelection = select.value;
    select.replaceChildren();
    if (sessions.length === 0) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "No persisted sessions";
      select.appendChild(option);
      select.disabled = true;
      if (state.mode === "review" && state.review.sessionId !== null) void loadReplaySession("");
      return;
    }

    for (const session of sessions) {
      const option = document.createElement("option");
      option.value = session.session_id;
      option.textContent = `${session.status} · ${formatTime(session.created_at_ms)} · ${session.device_id} · ${shortId(session.session_id)}`;
      select.appendChild(option);
    }
    select.disabled = false;
    const selectionStillExists = sessions.some((session) => session.session_id === previousSelection);
    select.value = selectionStillExists ? previousSelection : sessions[0].session_id;
    if (
      state.mode === "review" &&
      (state.review.sessionId === null || !sessions.some((session) => session.session_id === state.review.sessionId))
    ) {
      void loadReplaySession(select.value);
    }
  }

  function renderHistory(sessions) {
    state.historySessions = sessions;
    updateReviewSessionOptions(sessions);
    const body = byId("history-body");
    body.replaceChildren();
    if (sessions.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.className = "empty-state";
      cell.textContent = "No persisted monitoring sessions yet.";
      row.appendChild(cell);
      body.appendChild(row);
      return;
    }

    for (const session of sessions) {
      const row = document.createElement("tr");
      row.className = "session-row";
      row.dataset.sessionId = session.session_id;
      row.tabIndex = 0;
      row.title = `Review session ${session.session_id}`;
      row.setAttribute("aria-label", `${session.status} session from ${formatTime(session.created_at_ms)}, device ${session.device_id}`);
      const selectForReview = () => {
        byId("review-session-select").value = session.session_id;
        if (state.mode !== "review") setMode("review");
        else void loadReplaySession(session.session_id);
      };
      row.addEventListener("click", selectForReview);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectForReview();
        }
      });
      appendHistoryCell(row, session.status, "table-status");
      const sessionCell = appendHistoryCell(row, shortId(session.session_id));
      sessionCell.title = session.session_id;
      appendHistoryCell(row, session.device_id);
      appendHistoryCell(row, formatTime(session.created_at_ms));
      appendHistoryCell(row, formatTime(session.completed_at_ms));
      body.appendChild(row);
    }
    updateReviewedSessionHighlight();
  }

  function updateReviewedSessionHighlight() {
    document.querySelectorAll("#history-body tr[data-session-id]").forEach((row) => {
      row.classList.toggle(
        "reviewed-session",
        state.mode === "review" && row.dataset.sessionId === state.review.sessionId,
      );
    });
  }

  async function refreshHistory() {
    if (state.historyRefreshing) return;
    state.historyRefreshing = true;
    try {
      const result = await requestJson(`${API_BASE}/sessions`);
      renderHistory(Array.isArray(result.sessions) ? result.sessions : []);
      setText("history-updated", `Updated ${new Intl.DateTimeFormat(undefined, { timeStyle: "medium" }).format(new Date())}`);
      clearError("history");
    } catch (error) {
      showError(`Unable to load persistent session history: ${error.message}`, "history");
      setText("history-updated", "History unavailable");
    } finally {
      state.historyRefreshing = false;
    }
  }

  async function runSessionAction(action) {
    if (state.actionPending) return;
    state.actionPending = true;
    clearError();
    if (state.status) applyStatus(state.status);
    try {
      await action();
      await Promise.all([refreshStatus(), refreshHistory()]);
    } catch (error) {
      showError(error.message, "action");
      await refreshStatus();
    } finally {
      state.actionPending = false;
      if (state.status) applyStatus(state.status);
    }
  }

  byId("start-button").addEventListener("click", () => {
    if (DEMO_MODE) return;
    runSessionAction(() => requestJson(`${API_BASE}/sessions`, {
      method: "POST",
      body: JSON.stringify({ device_id: state.configuredDeviceId }),
    }));
  });

  byId("stop-button").addEventListener("click", () => {
    if (DEMO_MODE) return;
    if (!state.activeSessionId) return;
    runSessionAction(() => requestJson(
      `${API_BASE}/sessions/${encodeURIComponent(state.activeSessionId)}/stop`,
      { method: "POST", body: "{}" },
    ));
  });

  byId("demo-stop-button").addEventListener("click", stopDemo);

  byId("live-mode-button").addEventListener("click", () => setMode("live"));
  byId("review-mode-button").addEventListener("click", () => setMode("review"));
  byId("review-session-select").addEventListener("change", (event) => {
    if (state.mode === "review") void loadReplaySession(event.target.value);
  });
  byId("replay-play-button").addEventListener("click", () => {
    if (state.review.playing) {
      stopReplayAnimation();
      updateReplayPresentation();
    } else {
      startReplayAnimation();
    }
  });
  byId("replay-restart-button").addEventListener("click", () => {
    stopReplayAnimation();
    setReplayPosition(0);
  });
  byId("replay-speed").addEventListener("change", (event) => {
    const speed = Number(event.target.value);
    if ([0.5, 1, 2, 4].includes(speed)) state.review.replaySpeed = speed;
    state.review.previousAnimationNow = null;
    updateReplayPresentation();
  });
  byId("replay-seek").addEventListener("input", (event) => {
    const position = Number(event.target.value);
    if (Number.isFinite(position)) setReplayPosition(position);
  });
  byId("review-focus-controls").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-focus]");
    if (button !== null) setReviewFocus(button.dataset.focus);
  });

  window.addEventListener("beforeunload", closeLiveSocket);
  applyModePresentation();
  void refreshDemoScenarios();
  void refreshStatus();
  void refreshHistory();
  window.setInterval(refreshStatus, STATUS_INTERVAL_MS);
  window.setInterval(refreshHistory, HISTORY_INTERVAL_MS);
})();
