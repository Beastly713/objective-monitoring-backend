(() => {
  "use strict";

  const API_BASE = "/api/objective/demo";
  const DEMO_WS_PATH = "/ws/objective/demo/live";
  const VISIBLE_DURATION_MS = 30_000;
  const MODALITIES = ["ecg", "ppg", "gsr", "imu", "temperature"];
  const MODALITY_LABELS = {
    ecg: "ECG",
    ppg: "PPG",
    gsr: "GSR",
    imu: "IMU",
    temperature: "TEMP",
  };

  const state = {
    scenarios: [],
    selectedScenarioId: null,
    sessionId: null,
    status: null,
    socket: null,
    socketReady: false,
    runRequestPending: false,
    statusRefreshing: false,
    resultRefreshing: false,
    resultSessionId: null,
    windows: new Map(),
    selectedWindowKey: null,
    finalResult: null,
    errorSource: null,
  };

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = String(value);
  }

  function finiteNumber(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function formatNumber(value) {
    const number = finiteNumber(value);
    return number === null ? "—" : new Intl.NumberFormat().format(number);
  }

  function formatDuration(ms) {
    const value = Math.max(0, finiteNumber(ms) ?? 0);
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1_000);
    const millis = Math.floor(value % 1_000);
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
  }

  function formatValue(value, digits = 2) {
    const number = finiteNumber(value);
    return number === null ? "—" : number.toFixed(digits);
  }

  function modalityLabel(modality) {
    return MODALITY_LABELS[modality] ?? String(modality).toUpperCase();
  }

  function showError(message, source = "demo") {
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

  function setTone(element, tone) {
    if (!element) return;
    element.classList.remove("good", "bad", "neutral");
    element.classList.add(tone);
  }

  function isBusyPhase(phase) {
    return ["PREPARING", "READY", "STREAMING", "FINALIZING"].includes(phase);
  }

  async function requestJson(url, options = {}) {
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

  function chartOptions(element, series) {
    return {
      width: Math.max(320, element.clientWidth),
      height: 250,
      padding: [10, 8, 0, 2],
      legend: { show: series.length > 1 },
      scales: {
        x: { time: false, auto: false, range: [0, VISIBLE_DURATION_MS / 1_000] },
        y: { auto: true },
      },
      axes: [
        {
          stroke: "#7f96aa",
          grid: { stroke: "#1d344a", width: 1 },
          ticks: { stroke: "#294760" },
          values: (_plot, values) => values.map((value) => `${Number(value).toFixed(0)}s`),
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

  function createChart(elementId, series) {
    const element = byId(elementId);
    const data = Array.from({ length: series.length + 1 }, () => []);
    const plot = new uPlot(chartOptions(element, series), data, element);
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => {
        const width = Math.floor(element.clientWidth);
        if (width > 0 && width !== plot.width) plot.setSize({ width, height: 250 });
      });
      observer.observe(element);
    }
    return { data, plot };
  }

  const charts = {
    ecg: createChart("ecg-chart", [{ label: "ADC", color: "#62d6c8" }]),
    ppg: createChart("ppg-chart", [
      { label: "RED", color: "#ff6b78" },
      { label: "IR", color: "#7bb4ff" },
    ]),
    gsr: createChart("gsr-chart", [{ label: "Raw", color: "#f1b85b" }]),
    imu: createChart("imu-chart", [{ label: "Magnitude g", color: "#ad8cff" }]),
    temperature: createChart("temperature-chart", [{ label: "°C", color: "#ff9d66" }]),
  };

  function clearCharts() {
    for (const chart of Object.values(charts)) {
      chart.data.forEach((values) => { values.length = 0; });
      chart.plot.setData(chart.data);
    }
    setText("ecg-reading", "—");
    setText("ppg-reading", "—");
    setText("gsr-reading", "—");
    setText("imu-reading", "—");
    setText("temperature-reading", "—");
  }

  function appendPoints(chart, timesMs, columns) {
    if (timesMs.length === 0) return;
    const times = timesMs.map((value) => value / 1_000);
    chart.data[0].push(...times);
    columns.forEach((values, index) => chart.data[index + 1].push(...values));
    chart.plot.setData(chart.data);
  }

  function sampleTimes(plotT0Ms, samples) {
    return samples.map((sample) => plotT0Ms + sample[0] / 1_000);
  }

  function processPacket(packet) {
    if (!packet || packet.session_id !== state.sessionId || !packet.raw_packet) return;
    const raw = packet.raw_packet;
    const base = finiteNumber(packet.plot_t0_ms);
    if (base === null) return;

    if (Array.isArray(raw.ecg) && raw.ecg.length > 0) {
      appendPoints(charts.ecg, sampleTimes(base, raw.ecg), [raw.ecg.map((sample) => sample[1])]);
      setText("ecg-reading", `ADC ${formatNumber(raw.ecg.at(-1)[1])}`);
    }
    if (Array.isArray(raw.ppg) && raw.ppg.length > 0) {
      appendPoints(charts.ppg, sampleTimes(base, raw.ppg), [
        raw.ppg.map((sample) => sample[1]),
        raw.ppg.map((sample) => sample[2]),
      ]);
      const latest = raw.ppg.at(-1);
      setText("ppg-reading", `RED ${formatNumber(latest[1])} · IR ${formatNumber(latest[2])}`);
    }
    if (Array.isArray(raw.gsr) && raw.gsr.length > 0) {
      appendPoints(charts.gsr, sampleTimes(base, raw.gsr), [raw.gsr.map((sample) => sample[1])]);
      setText("gsr-reading", `Raw ${formatNumber(raw.gsr.at(-1)[1])}`);
    }
    if (Array.isArray(raw.imu) && raw.imu.length > 0) {
      const magnitudes = raw.imu.map((sample) => {
        const ax = sample[1] / 16_384;
        const ay = sample[2] / 16_384;
        const az = sample[3] / 16_384;
        return Math.sqrt(ax * ax + ay * ay + az * az);
      });
      appendPoints(charts.imu, sampleTimes(base, raw.imu), [magnitudes]);
      setText("imu-reading", `Magnitude ${formatValue(magnitudes.at(-1), 3)} g`);
    }
    if (Array.isArray(raw.temp) && raw.temp.length > 0) {
      const temperatures = raw.temp.map((sample) => sample[1] * 0.0078125);
      appendPoints(charts.temperature, sampleTimes(base, raw.temp), [temperatures]);
      setText("temperature-reading", `${formatValue(temperatures.at(-1))} °C`);
    }
  }

  function analysisKey(result) {
    return [result.session_id, result.epoch_id, result.window?.start_ms, result.window?.end_ms].join(":");
  }

  function ingestAnalysisResult(result) {
    if (!result || result.session_id !== state.sessionId || !result.window) return;
    const start = finiteNumber(result.window.start_ms);
    const end = finiteNumber(result.window.end_ms);
    if (start === null || end === null || start < 0 || end <= start || end > VISIBLE_DURATION_MS) return;
    const key = analysisKey(result);
    if (state.windows.has(key)) return;
    state.windows.set(key, result);
    const ordered = [...state.windows.entries()]
      .sort(([, left], [, right]) => left.window.start_ms - right.window.start_ms)
      .slice(-3);
    state.windows = new Map(ordered);
    state.selectedWindowKey = key;
    renderWindows();
    renderLatest(result);
  }

  function windowNumber(result) {
    const start = finiteNumber(result?.window?.start_ms);
    return start === null ? null : Math.floor(start / 10_000) + 1;
  }

  function windowRange(result) {
    return `T+${formatDuration(result?.window?.start_ms)}–T+${formatDuration(result?.window?.end_ms)}`;
  }

  function firedRuleIds(result) {
    const ids = new Set(result?.rules_triggered ?? []);
    (result?.multimodal_result?.rule_ids ?? []).forEach((ruleId) => ids.add(ruleId));
    for (const modality of MODALITIES) {
      for (const rule of result?.modality_results?.[modality]?.rule_evaluations ?? []) {
        if (rule.status === "fired") ids.add(rule.rule_id);
      }
    }
    return [...ids];
  }

  function qualityPills(result) {
    const container = document.createElement("div");
    container.className = "quality-pills";
    for (const modality of MODALITIES) {
      const stateText = result?.modality_results?.[modality]?.quality?.state ?? "unavailable";
      const pill = document.createElement("span");
      pill.className = `quality-pill${stateText === "good" ? "" : " bad"}`;
      pill.textContent = `${modalityLabel(modality)} ${stateText.toUpperCase()}`;
      container.appendChild(pill);
    }
    return container;
  }

  function renderWindows() {
    const container = byId("completed-window-analysis");
    container.replaceChildren();
    const rows = [...state.windows.entries()].sort(([, left], [, right]) =>
      left.window.start_ms - right.window.start_ms);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "No completed analysis windows yet.";
      container.appendChild(empty);
      return;
    }
    for (const [key, result] of rows) {
      const card = document.createElement("article");
      card.className = "window-card";
      card.classList.toggle("selected", key === state.selectedWindowKey);
      card.tabIndex = 0;
      card.addEventListener("click", () => {
        state.selectedWindowKey = key;
        renderWindows();
        renderLatest(result);
      });
      const header = document.createElement("div");
      header.className = "window-card-header";
      const title = document.createElement("strong");
      title.textContent = `W${windowNumber(result) ?? "—"} · ${windowRange(result)}`;
      const evidence = document.createElement("span");
      evidence.className = "status-pill neutral";
      evidence.textContent = result.multimodal_result?.evidence_tier ?? "insufficient";
      header.append(title, evidence);
      const pattern = document.createElement("p");
      pattern.className = "window-card-pattern";
      pattern.textContent = result.multimodal_result?.pattern ?? "No pattern recorded";
      const explanation = document.createElement("p");
      explanation.className = "window-card-explanation";
      explanation.textContent = result.multimodal_result?.explanation ?? "No explanation recorded.";
      const meta = document.createElement("div");
      meta.className = "window-card-meta";
      const supporting = (result.multimodal_result?.supporting_modalities ?? []).map(modalityLabel).join(", ") || "None";
      const contradicting = (result.multimodal_result?.contradicting_modalities ?? []).map(modalityLabel).join(", ") || "None";
      meta.textContent = `Supporting: ${supporting} · Contradicting: ${contradicting} · Rules: ${firedRuleIds(result).join(", ") || "None"}`;
      card.append(header, pattern, explanation, meta, qualityPills(result));
      container.appendChild(card);
    }
  }

  function displayFeature(result, modality, key) {
    const modalityResult = result?.modality_results?.[modality];
    const value = modalityResult?.features?.[key];
    const meta = modalityResult?.feature_meta?.[key];
    if (!meta?.valid || value === null || value === undefined) return "—";
    if (typeof value === "number") return `${formatValue(value)}${meta.unit ? ` ${meta.unit}` : ""}`;
    return `${value}${meta.unit ? ` (${meta.unit})` : ""}`;
  }

  function renderLatest(result) {
    if (!result) {
      setText("latest-window-label", "No window selected");
      setText("latest-evidence", "—");
      setText("latest-pattern", "—");
      setText("latest-explanation", "—");
      setText("latest-supporting", "—");
      setText("latest-contradicting", "—");
      setText("latest-rules", "—");
      byId("latest-features").replaceChildren();
      return;
    }
    setText("latest-window-label", `W${windowNumber(result) ?? "—"} · ${windowRange(result)}`);
    setText("latest-evidence", result.multimodal_result?.evidence_tier ?? "insufficient");
    setText("latest-pattern", result.multimodal_result?.pattern ?? "No pattern recorded");
    setText("latest-explanation", result.multimodal_result?.explanation ?? "No explanation recorded.");
    setText("latest-supporting", (result.multimodal_result?.supporting_modalities ?? []).map(modalityLabel).join(", ") || "None");
    setText("latest-contradicting", (result.multimodal_result?.contradicting_modalities ?? []).map(modalityLabel).join(", ") || "None");
    setText("latest-rules", firedRuleIds(result).join(", ") || "None");

    const features = [
      ["ECG heart rate", "ecg", "heart_rate_bpm"],
      ["PPG pulse rate", "ppg", "pulse_rate_bpm"],
      ["GSR raw mean", "gsr", "gsr_raw_mean"],
      ["GSR slope", "gsr", "gsr_raw_slope_raw_per_s"],
      ["GSR robust-z", "gsr", "gsr_robust_z"],
      ["IMU movement", "imu", "movement_level"],
      ["IMU motion index", "imu", "motion_index_g"],
      ["Temperature", "temperature", "temperature_mean_c"],
      ["Temperature delta", "temperature", "temperature_delta_c"],
    ];
    const container = byId("latest-features");
    container.replaceChildren();
    for (const [label, modality, key] of features) {
      const card = document.createElement("div");
      card.className = "feature-card";
      const name = document.createElement("dt");
      name.textContent = label;
      const value = document.createElement("dd");
      value.textContent = displayFeature(result, modality, key);
      card.append(name, value);
      container.appendChild(card);
    }
  }

  function renderScenarios() {
    const container = byId("scenario-container");
    container.replaceChildren();
    if (state.scenarios.length === 0) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Loading scenarios…";
      container.appendChild(empty);
      return;
    }
    for (const scenario of state.scenarios) {
      const card = document.createElement("article");
      card.className = "scenario-card";
      card.classList.toggle("selected", scenario.id === state.selectedScenarioId);
      card.classList.toggle("running", scenario.id === state.status?.scenario?.id && isBusyPhase(state.status?.phase));
      const title = document.createElement("h3");
      title.textContent = scenario.title;
      const description = document.createElement("p");
      description.textContent = scenario.description;
      const expected = document.createElement("span");
      expected.className = "scenario-expected";
      expected.textContent = `Expected pattern: ${scenario.expected_pattern} · ${scenario.expected_evidence_tier} evidence`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "button primary";
      button.textContent = "Run scenario";
      button.disabled = state.runRequestPending || isBusyPhase(state.status?.phase);
      button.addEventListener("click", () => { void runScenario(scenario.id); });
      card.append(title, description, expected, button);
      container.appendChild(card);
    }
  }

  function renderStatus(status) {
    state.status = status;
    if (status?.scenario?.id) {
      state.selectedScenarioId = status.scenario.id;
      if (state.sessionId === null) state.sessionId = status.session_id;
    }
    const phase = status?.phase ?? "IDLE";
    const scenario = status?.scenario;
    const elapsed = finiteNumber(status?.visible_elapsed_ms) ?? 0;
    const duration = finiteNumber(status?.visible_duration_ms) ?? VISIBLE_DURATION_MS;
    setText("current-scenario-title", scenario?.title ?? "Choose a scenario");
    setText("demo-phase", phase);
    setTone(byId("demo-phase"), phase === "ERROR" ? "bad" : phase === "COMPLETE" ? "good" : phase === "IDLE" ? "neutral" : "neutral");
    const phaseText = {
      IDLE: "Choose a scenario.",
      PREPARING: "Preparing deterministic baseline and scenario state…",
      READY: "Scenario prepared. Starting simulated stream…",
      STREAMING: `Running scenario · T+${formatDuration(elapsed)} / ${formatDuration(duration)}`,
      FINALIZING: "Finalizing completed analysis windows…",
      COMPLETE: "Scenario complete.",
      ERROR: `Demonstration validation failed${status?.error ? `: ${status.error}` : "."}`,
    }[phase] ?? "Choose a scenario.";
    setText("demo-status", phaseText);
    const progress = byId("demo-progress");
    progress.max = duration;
    progress.value = Math.min(duration, elapsed);
    setText("demo-progress-label", `T+${formatDuration(elapsed)} / ${formatDuration(duration)}`);
    setText("demo-packet-count", formatNumber(status?.visible_packet_count));
    setText("demo-window-count", formatNumber(status?.completed_window_count));
    const readyCount = Array.isArray(status?.baseline_ready_modalities) ? status.baseline_ready_modalities.length : 0;
    setText("demo-baseline-state", `${readyCount}/5`);
    const validation = status?.validation ?? { state: "pending", message: null };
    const validationElement = byId("demo-validation-state");
    validationElement.textContent = validation.state === "passed"
      ? "Validation passed"
      : validation.state === "failed"
        ? `Validation failed${validation.message ? ` · ${validation.message}` : ""}`
        : "Validation pending";
    setTone(validationElement, validation.state === "passed" ? "good" : validation.state === "failed" ? "bad" : "neutral");
    renderScenarios();

    if (status?.latest_result) ingestAnalysisResult(status.latest_result);
    if (["COMPLETE", "ERROR"].includes(phase) && status.session_id && state.resultSessionId !== status.session_id) {
      void refreshResult(status.session_id);
    }
  }

  async function refreshStatus() {
    if (state.statusRefreshing) return;
    state.statusRefreshing = true;
    try {
      renderStatus(await requestJson(`${API_BASE}/status`));
      if (state.errorSource === "status") clearError("status");
    } catch (error) {
      showError(`Unable to refresh demonstration status: ${error.message}`, "status");
    } finally {
      state.statusRefreshing = false;
    }
  }

  function addFinalCard(container, title, content) {
    const card = document.createElement("article");
    card.className = "final-card";
    const heading = document.createElement("h3");
    heading.textContent = title;
    card.appendChild(heading);
    if (typeof content === "string") {
      const paragraph = document.createElement("p");
      paragraph.textContent = content;
      card.appendChild(paragraph);
    } else {
      card.appendChild(content);
    }
    container.appendChild(card);
    return card;
  }

  function listElement(items) {
    const list = document.createElement("ul");
    for (const item of items) {
      const row = document.createElement("li");
      row.textContent = item;
      list.appendChild(row);
    }
    return list;
  }

  function renderFeatureTrends(finalAnalysis) {
    const wrapper = document.createElement("div");
    for (const modality of MODALITIES) {
      const trends = finalAnalysis?.feature_trends?.[modality] ?? {};
      const entries = Object.entries(trends).filter(([, trend]) => Number(trend.valid_window_count ?? 0) > 0);
      if (entries.length === 0) continue;
      const heading = document.createElement("p");
      heading.textContent = modalityLabel(modality);
      heading.className = "muted";
      wrapper.appendChild(heading);
      const table = document.createElement("table");
      table.className = "trend-table";
      const head = document.createElement("tr");
      ["Feature", "First", "Last", "Change"].forEach((label) => {
        const cell = document.createElement("th");
        cell.textContent = label;
        head.appendChild(cell);
      });
      const thead = document.createElement("thead");
      thead.appendChild(head);
      table.appendChild(thead);
      const body = document.createElement("tbody");
      for (const [feature, trend] of entries) {
        const row = document.createElement("tr");
        [
          feature,
          formatValue(trend.first_valid),
          formatValue(trend.last_valid),
          formatValue(trend.change_from_first_to_last),
        ].forEach((value) => {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.appendChild(cell);
        });
        body.appendChild(row);
      }
      table.appendChild(body);
      wrapper.appendChild(table);
    }
    if (wrapper.children.length === 0) {
      const note = document.createElement("p");
      note.textContent = "No valid feature trends.";
      wrapper.appendChild(note);
    }
    return wrapper;
  }

  function renderFinalResult(result) {
    state.finalResult = result;
    const finalAnalysis = result?.final_analysis;
    const container = byId("final-scenario-summary");
    container.replaceChildren();
    if (!finalAnalysis) {
      const note = document.createElement("p");
      note.className = "muted";
      note.textContent = "The final synthesis is not available.";
      container.appendChild(note);
      setText("final-state", "Unavailable");
      setTone(byId("final-state"), "bad");
      return;
    }

    const validation = result.validation ?? { state: "pending", message: null };
    setText("final-state", validation.state === "passed" ? "Validation passed" : validation.state === "failed" ? "Validation failed" : "Pending");
    setTone(byId("final-state"), validation.state === "passed" ? "good" : validation.state === "failed" ? "bad" : "neutral");
    const grid = document.createElement("div");
    grid.className = "final-grid";
    addFinalCard(grid, "Scenario", listElement([
      result.scenario.title,
      `Expected: ${result.scenario.expected_pattern}`,
      `Expected evidence: ${result.scenario.expected_evidence_tier}`,
    ]));

    const patterns = Object.entries(finalAnalysis.multimodal_summary?.patterns ?? {}).map(([pattern, summary]) =>
      `${pattern} · ${summary.count} window${summary.count === 1 ? "" : "s"} · ${(summary.evidence_tiers ?? []).join(", ")}`);
    addFinalCard(grid, "Actual pipeline behavior", listElement(patterns.length > 0 ? patterns : ["No completed pattern recorded."]));

    const session = finalAnalysis.session ?? {};
    const coverage = finalAnalysis.window_coverage ?? {};
    addFinalCard(grid, "Visible coverage", listElement([
      `Completed windows: ${session.completed_window_count ?? 0}/3`,
      `Duration: ${formatDuration(session.duration_ms)}`,
      `Missing windows: ${(coverage.missing_windows ?? []).length}`,
      `Incomplete tails: ${(coverage.incomplete_tails ?? []).length}`,
    ]));

    const quality = finalAnalysis.quality?.modality_quality_states ?? {};
    addFinalCard(grid, "Quality", listElement(MODALITIES.map((modality) => {
      const counts = quality[modality] ?? {};
      return `${modalityLabel(modality)} · good ${counts.good ?? 0} · usable ${counts.usable ?? 0} · limited ${counts.limited ?? 0}`;
    })));

    const baselineModalities = result.baseline_ready_modalities ?? finalAnalysis.baseline?.ready_modalities ?? [];
    addFinalCard(grid, "Baseline readiness", listElement([
      `${baselineModalities.length}/5 modalities ready`,
      `Collection complete: ${finalAnalysis.baseline?.collection_complete === true ? "yes" : "no"}`,
      `Validation: ${validation.state}${validation.message ? ` · ${validation.message}` : ""}`,
    ]));

    const firedRules = Object.entries(finalAnalysis.rule_summary ?? {})
      .filter(([, summary]) => Number(summary.fired_window_count ?? 0) > 0)
      .map(([ruleId, summary]) => `${ruleId} · ${summary.fired_window_count} window${summary.fired_window_count === 1 ? "" : "s"}`);
    addFinalCard(grid, "Rules and support", listElement([
      `Rules: ${firedRules.join(", ") || "None"}`,
      `Supporting modalities: ${[...new Set((finalAnalysis.window_observations ?? []).flatMap((observation) => observation.supporting_modalities ?? []))].map(modalityLabel).join(", ") || "None"}`,
    ]));

    const trendCard = addFinalCard(grid, "Useful feature trends", renderFeatureTrends(finalAnalysis));
    trendCard.classList.add("final-wide");
    container.appendChild(grid);
  }

  async function refreshResult(sessionId) {
    if (state.resultRefreshing || !sessionId) return;
    state.resultRefreshing = true;
    try {
      const result = await requestJson(`${API_BASE}/result`);
      if (state.sessionId === sessionId || state.sessionId === null) {
        state.sessionId = sessionId;
        state.resultSessionId = sessionId;
        for (const completed of result.completed_results ?? []) ingestAnalysisResult(completed);
        renderFinalResult(result);
      }
    } catch (error) {
      if (state.status?.phase === "COMPLETE" || state.status?.phase === "ERROR") {
        showError(`Unable to load final demonstration result: ${error.message}`, "result");
      }
    } finally {
      state.resultRefreshing = false;
    }
  }

  function handleSocketMessage(event) {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "ready") {
      if (message.session_id === state.sessionId) state.socketReady = true;
      return;
    }
    if (message.type === "packet") processPacket(message.packet);
    if (message.type === "analysis_update") ingestAnalysisResult(message.result);
  }

  function closeSocket() {
    const socket = state.socket;
    state.socket = null;
    state.socketReady = false;
    if (socket && socket.readyState < 2) socket.close();
  }

  function resetFinalSummary() {
    state.finalResult = null;
    setText("final-state", "Pending");
    setTone(byId("final-state"), "neutral");
    const container = byId("final-scenario-summary");
    container.replaceChildren();
    const note = document.createElement("p");
    note.className = "muted";
    note.textContent = "The final summary appears after W1, W2, and W3 complete.";
    container.appendChild(note);
  }

  function connectSocket(sessionId) {
    return new Promise((resolve, reject) => {
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(`${scheme}//${window.location.host}${DEMO_WS_PATH}/${encodeURIComponent(sessionId)}`);
      state.socket = socket;
      let settled = false;
      socket.addEventListener("message", (event) => {
        handleSocketMessage(event);
        if (!settled && state.socketReady) {
          settled = true;
          resolve();
        }
      });
      socket.addEventListener("error", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Unable to start demonstration stream."));
        }
      });
      socket.addEventListener("close", () => {
        if (!settled) {
          settled = true;
          reject(new Error("Unable to start demonstration stream."));
        }
        if (state.status && isBusyPhase(state.status.phase) && state.runRequestPending) {
          showError("Unable to start demonstration stream.");
        }
      });
    });
  }

  function resetForScenario() {
    closeSocket();
    state.windows.clear();
    state.selectedWindowKey = null;
    state.resultSessionId = null;
    clearCharts();
    renderWindows();
    renderLatest(null);
    resetFinalSummary();
  }

  async function runScenario(scenarioId) {
    if (state.runRequestPending || isBusyPhase(state.status?.phase)) return;
    state.runRequestPending = true;
    try {
      state.selectedScenarioId = scenarioId;
      clearError();
      resetForScenario();
      renderScenarios();
      const prepared = await requestJson(`${API_BASE}/start`, {
        method: "POST",
        body: JSON.stringify({ scenario_id: scenarioId }),
      });
      state.sessionId = prepared.session_id;
      renderStatus(prepared.status);
      // The server does not publish visible packets until this ready handshake
      // completes, so the first visible packet cannot race the chart client.
      await connectSocket(prepared.session_id);
      await requestJson(`${API_BASE}/run`, {
        method: "POST",
        body: JSON.stringify({ session_id: prepared.session_id }),
      });
      await refreshStatus();
    } catch (error) {
      showError(error.message, "demo");
      if (state.sessionId && state.status?.phase === "READY") {
        await requestJson(`${API_BASE}/abort`, {
          method: "POST",
          body: JSON.stringify({ session_id: state.sessionId }),
        }).catch(() => undefined);
      }
      await refreshStatus();
    } finally {
      state.runRequestPending = false;
      renderScenarios();
    }
  }

  async function refreshScenarios() {
    try {
      const response = await requestJson(`${API_BASE}/scenarios`);
      state.scenarios = Array.isArray(response?.scenarios) ? response.scenarios : [];
      renderScenarios();
    } catch (error) {
      showError(`Unable to load demonstration scenarios: ${error.message}`, "scenarios");
    }
  }

  window.addEventListener("beforeunload", closeSocket);
  renderWindows();
  renderLatest(null);
  resetFinalSummary();
  renderStatus({
    phase: "IDLE",
    scenario: null,
    session_id: null,
    visible_elapsed_ms: 0,
    visible_duration_ms: VISIBLE_DURATION_MS,
    visible_packet_count: 0,
    completed_window_count: 0,
    baseline_ready: false,
    baseline_ready_modalities: [],
    latest_result: null,
    validation: { state: "pending", message: null },
    final_analysis: { session_id: null, state: "unavailable", available: false },
    error: null,
  });
  void refreshScenarios();
  void refreshStatus();
  window.setInterval(refreshStatus, 1_000);
})();
