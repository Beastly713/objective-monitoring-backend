(() => {
  "use strict";

  const STATUS_INTERVAL_MS = 1_000;
  const HISTORY_INTERVAL_MS = 10_000;
  const LIVE_RECONNECT_MS = 1_000;
  const REPLAY_CHUNK_MS = 30_000;
  const REPLAY_VIEWPORT_MS = 30_000;
  const MAX_REPLAY_CACHE_CHUNKS = 3;

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
    lastLiveSequence: null,
    previousRateSample: null,
    errorSource: null,
    review: {
      selectionGeneration: 0,
      sessionId: null,
      manifest: null,
      replayPositionMs: 0,
      replaySpeed: 1,
      playing: false,
      inspectionPositionMs: null,
      focusSignal: "all",
      previousAnimationNow: null,
      animationFrame: null,
      cache: new Map(),
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
    const buffer = { data, plot, element, windowMs, maxPoints, breakPending: false };

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
    buffer.breakPending = false;
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
    state.lastLiveSequence = null;
    setText("epoch-state", "Waiting for data");
    resetSignalReadings();
  }

  function markDiscontinuity() {
    Object.values(charts).forEach((buffer) => { buffer.breakPending = true; });
  }

  function appendPoints(buffer, times, valueColumns) {
    if (times.length === 0) return;
    const xValues = buffer.data[0];

    if (buffer.breakPending && xValues.length > 0) {
      const previousX = xValues[xValues.length - 1];
      const nextX = times[0];
      if (nextX > previousX) {
        xValues.push(previousX + (nextX - previousX) / 2);
        for (let column = 1; column < buffer.data.length; column += 1) {
          buffer.data[column].push(null);
        }
      } else {
        for (const values of buffer.data) values.length = 0;
      }
    }
    buffer.breakPending = false;

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
      state.currentEpochId = packet.epoch_id;
      state.lastLiveSequence = null;
      boundaryLabel = bootChanged ? "Device reboot" : "Time/backend epoch";
      setText("epoch-state", `${boundaryLabel} · ${shortId(previousEpoch)} → ${shortId(packet.epoch_id)}`);
    } else if (bootChanged) {
      Object.values(charts).forEach(clearChart);
      state.lastLiveSequence = null;
      boundaryLabel = "Device reboot";
      setText("epoch-state", `${boundaryLabel} · boot ${shortId(packet.boot_id)}`);
    }

    const backendGap = packet.gap_before > 0 || packet.sequence_status === "gap";
    const currentSequence = packet.raw_packet.seq;
    const liveDeliveryGap =
      !backendGap &&
      !epochChanged &&
      !bootChanged &&
      state.lastLiveBootId === packet.boot_id &&
      Number.isInteger(state.lastLiveSequence) &&
      Number.isInteger(currentSequence) &&
      currentSequence > state.lastLiveSequence + 1;

    if (backendGap) {
      markDiscontinuity();
      setText(
        "epoch-state",
        boundaryLabel !== null
          ? `${boundaryLabel} · ingestion gap before seq ${packet.raw_packet.seq}`
          : `Gap before seq ${packet.raw_packet.seq} · epoch ${shortId(packet.epoch_id)}`,
      );
    } else if (liveDeliveryGap) {
      markDiscontinuity();
      setText("epoch-state", `Live delivery gap before seq ${currentSequence}`);
    }

    state.lastLiveBootId = packet.boot_id;
    state.lastLiveSequence = currentSequence;

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
      `/api/objective/sessions/${encodeURIComponent(sessionId)}/replay/packets?from_ms=${fromMs}&duration_ms=${chunkDurationMs}`,
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
    state.review.cache.clear();
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
      setReplayStatus("Select a persisted session to review.");
      return;
    }

    setReplayStatus("Loading replay manifest…");
    try {
      const result = await requestJson(
        `/api/objective/sessions/${encodeURIComponent(sessionId)}/replay`,
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

  function applyModePresentation() {
    const reviewing = state.mode === "review";
    document.body.dataset.mode = state.mode;
    byId("live-mode-button").classList.toggle("active", !reviewing);
    byId("review-mode-button").classList.toggle("active", reviewing);
    byId("live-mode-button").setAttribute("aria-pressed", String(!reviewing));
    byId("review-mode-button").setAttribute("aria-pressed", String(reviewing));
    byId("review-controls").hidden = !reviewing;
    byId("review-focus-controls").hidden = !reviewing;
    byId("inspection-panel").hidden = !reviewing;
    setText("dashboard-title", reviewing ? "Clinician historical review" : "Clinician monitoring");
    setText(
      "dashboard-subtitle",
      reviewing ? "Persisted raw sensor replay · live monitoring continues independently" : "Live raw sensor streams and operational health",
    );
    setText("signals-kicker", reviewing ? "Historical signals · REVIEW" : "Live signals · LIVE");
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
      state.review.cache.clear();
      setReplayWarning("");
      clearError("replay");
      clearSignalState();
    }
    applyModePresentation();
    if (mode === "review") {
      void loadReplaySession(byId("review-session-select").value);
    } else if (state.activeSessionId) {
      ensureLiveSocket(state.activeSessionId);
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
    const url = `${scheme}//${window.location.host}/ws/objective/live/${encodeURIComponent(sessionId)}`;
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
      closeLiveSocket();
      if (state.mode === "live") clearSignalState();
      state.activeSessionId = nextSessionId;
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
    setText("storage-queue", formatNumber(status.storage.queue_depth));
    setText("persisted-packets", formatNumber(status.storage.persisted_packets));
    setText(
      "storage-errors",
      `${formatNumber(status.storage.storage_errors)} / ${formatNumber(status.storage.storage_drops)}`,
    );
    updatePacketRate(status);

    byId("start-button").disabled =
      state.mode !== "live" || state.actionPending || session !== null || !state.configuredDeviceId;
    byId("stop-button").disabled = state.mode !== "live" || state.actionPending || session === null;
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
      applyStatus(await requestJson("/api/objective/status"));
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
      const result = await requestJson("/api/objective/sessions");
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
    runSessionAction(() => requestJson("/api/objective/sessions", {
      method: "POST",
      body: JSON.stringify({ device_id: state.configuredDeviceId }),
    }));
  });

  byId("stop-button").addEventListener("click", () => {
    if (!state.activeSessionId) return;
    runSessionAction(() => requestJson(
      `/api/objective/sessions/${encodeURIComponent(state.activeSessionId)}/stop`,
      { method: "POST", body: "{}" },
    ));
  });

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
  void refreshStatus();
  void refreshHistory();
  window.setInterval(refreshStatus, STATUS_INTERVAL_MS);
  window.setInterval(refreshHistory, HISTORY_INTERVAL_MS);
})();
