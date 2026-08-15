(() => {
  "use strict";

  const STATUS_INTERVAL_MS = 1_000;
  const HISTORY_INTERVAL_MS = 10_000;
  const LIVE_RECONNECT_MS = 1_000;

  const state = {
    status: null,
    activeSessionId: null,
    configuredDeviceId: null,
    liveSocket: null,
    socketSessionId: null,
    reconnectTimer: null,
    actionPending: false,
    statusRefreshing: false,
    historyRefreshing: false,
    currentEpochId: null,
    lastLiveBootId: null,
    lastLiveSequence: null,
    previousRateSample: null,
    errorSource: null,
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
      cursor: { show: false },
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
    const data = Array.from({ length: series.length + 1 }, () => []);
    const plot = new uPlot(chartOptions(element, series), data, element);
    const buffer = { data, plot, windowMs, maxPoints, breakPending: false };

    const observer = new ResizeObserver(() => {
      const width = Math.floor(element.clientWidth);
      if (width > 0 && width !== plot.width) {
        plot.setSize({ width, height: 220 });
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

  function clearSignalState() {
    Object.values(charts).forEach(clearChart);
    state.currentEpochId = null;
    state.lastLiveBootId = null;
    state.lastLiveSequence = null;
    setText("epoch-state", "Waiting for data");
    setText("ecg-lead-state", "Lead state —");
    setText("ppg-reading", "RED — · IR —");
    setText("gsr-reading", "Raw —");
    setText("imu-magnitude", "Magnitude — g");
    setText("imu-reading", "Accel — · Gyro —");
    setText("temperature-reading", "— °C");
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

    let epochChanged = false;
    if (state.currentEpochId === null) {
      state.currentEpochId = packet.epoch_id;
      setText("epoch-state", `Epoch ${shortId(packet.epoch_id)}`);
    } else if (packet.epoch_id !== state.currentEpochId) {
      epochChanged = true;
      const previousEpoch = state.currentEpochId;
      Object.values(charts).forEach(clearChart);
      state.currentEpochId = packet.epoch_id;
      state.lastLiveBootId = null;
      state.lastLiveSequence = null;
      setText(
        "epoch-state",
        `Epoch/device reboot changed · ${shortId(previousEpoch)} → ${shortId(packet.epoch_id)}`,
      );
    }

    const backendGap = packet.gap_before > 0 || packet.sequence_status === "gap";
    const currentSequence = packet.raw_packet.seq;
    const liveDeliveryGap =
      !backendGap &&
      !epochChanged &&
      state.lastLiveBootId === packet.boot_id &&
      Number.isInteger(state.lastLiveSequence) &&
      Number.isInteger(currentSequence) &&
      currentSequence > state.lastLiveSequence + 1;

    if (backendGap) {
      markDiscontinuity();
      setText(
        "epoch-state",
        epochChanged
          ? `Epoch/device reboot changed · gap before seq ${packet.raw_packet.seq}`
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
    if (!sessionId) return;
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
      if (state.activeSessionId === sessionId && state.reconnectTimer === null) {
        state.reconnectTimer = window.setTimeout(() => {
          state.reconnectTimer = null;
          if (state.activeSessionId === sessionId) ensureLiveSocket(sessionId);
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
      clearSignalState();
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
      ensureLiveSocket(session.session_id);
    }

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

    byId("start-button").disabled = state.actionPending || session !== null || !state.configuredDeviceId;
    byId("stop-button").disabled = state.actionPending || session === null;
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
  }

  function renderHistory(sessions) {
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
      appendHistoryCell(row, session.status, "table-status");
      appendHistoryCell(row, session.session_id);
      appendHistoryCell(row, session.device_id);
      appendHistoryCell(row, formatTime(session.created_at_ms));
      appendHistoryCell(row, formatTime(session.completed_at_ms));
      body.appendChild(row);
    }
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

  window.addEventListener("beforeunload", closeLiveSocket);
  void refreshStatus();
  void refreshHistory();
  window.setInterval(refreshStatus, STATUS_INTERVAL_MS);
  window.setInterval(refreshHistory, HISTORY_INTERVAL_MS);
})();
