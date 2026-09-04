(function () {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token") || "";

  const container = document.getElementById("pixi-container");
  const subtitleEl = document.getElementById("subtitle-container");
  const controlPanel = document.getElementById("control-panel");
  const lockBtn = document.getElementById("lock-btn");
  const hideBtn = document.getElementById("hide-btn");
  const subtitleBtn = document.getElementById("subtitle-btn");
  const wsStatusBtn = document.getElementById("ws-status-btn");
  const probeBtn = document.getElementById("probe-btn");
  const refreshBtn = document.getElementById("refresh-btn");
  const closeBtn = document.getElementById("close-btn");
  const dragBtn = document.getElementById("drag-btn");

  let app = null;
  let sprite = null;
  let renderWs = null;
  let eventsWs = null;
  let mx = 0;
  let my = 0;
  let connected = false;
  let eventsConnected = false;
  let isLocked = false;
  let isSubtitleEnabled = true;
  let isPanelHovered = false;
  let activeTooltipButton = null;
  let hideTimeout = null;
  let isAutoHideEnabled = false;
  let isModelHiddenByHover = false;
  let audioCtx = null;
  let audioAnalyser = null;
  let mouthTimer = null;
  let audioDelayMs = 150;
  let isPlayingAudio = false;
  let audioGeneration = 0;
  let currentAudioSource = null;
  let pcmStream = null;
  const systemMediaApi = window.electronAPI?.systemMedia;
  let systemMediaActive = false;
  const audioQueue = [];
  const motionTags = new Set(["nod", "shakeHead", "tiltHead", "bow", "sway", "lookAround"]);

  function setSystemMediaActive(active) {
    if (active === systemMediaActive) return Promise.resolve();
    systemMediaActive = active;
    if (systemMediaApi?.setTtsActive) {
      return systemMediaApi.setTtsActive(active).catch(() => undefined);
    }
    return Promise.resolve();
  }

  const LABELS = {
    lockWindow: "锁定窗口",
    unlockWindow: "解锁窗口",
    autoHideDescription: "鼠标悬停自动隐藏",
    autoHideEnabled: "自动隐藏已启用",
    refreshWindow: "刷新 / 重置",
    closeWindow: "关闭挂件",
    connected: "服务已连接",
    disconnected: "服务重连中...",
    dragWindow: "按住拖动",
    subtitleEnabled: "字幕已开启",
    subtitleDisabled: "字幕已关闭",
    probeLatency: "测量渲染延迟",
  };

  const BG_THRESHOLD = 0.18;

  const bgFilterVert = `
attribute vec2 aVertexPosition;
attribute vec2 aTextureCoord;
uniform mat3 projectionMatrix;
varying vec2 vTextureCoord;
void main(void) {
  gl_Position = vec4((projectionMatrix * vec3(aVertexPosition, 1.0)).xy, 0.0, 1.0);
  vTextureCoord = aTextureCoord;
}`;

  const bgFilterFrag = `
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform float uThreshold;
void main(void) {
  vec4 color = texture2D(uSampler, vTextureCoord);
  float greenDifference = color.g - max(color.r, color.b);
  float sensitivity = uThreshold * 0.8;
  if (greenDifference > sensitivity && color.g > 0.3) {
    gl_FragColor = vec4(0.0);
  } else {
    gl_FragColor = color;
  }
}`;

  const tooltipContainer = document.createElement("div");
  tooltipContainer.id = "control-tooltip-container";
  tooltipContainer.style.cssText =
    "position:fixed;z-index:100000;pointer-events:none;opacity:0;transform:translateX(-10px);transition:all 0.3s ease;";
  const customTooltip = document.createElement("div");
  customTooltip.id = "control-tooltip";
  customTooltip.style.cssText =
    "background:rgba(0,0,0,0.85);color:#fff;padding:8px 12px;border-radius:8px;font-size:13px;font-weight:500;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.15);backdrop-filter:blur(8px);";
  tooltipContainer.appendChild(customTooltip);
  document.body.appendChild(tooltipContainer);

  function showTooltip(button, text) {
    if (!text || !button) return;
    activeTooltipButton = button;
    const rect = button.getBoundingClientRect();
    customTooltip.textContent = text;
    const topPosition = rect.top + (rect.height - customTooltip.offsetHeight) / 2;
    tooltipContainer.style.left = `${rect.left - customTooltip.offsetWidth - 15}px`;
    tooltipContainer.style.top = `${topPosition}px`;
    tooltipContainer.style.opacity = "1";
    tooltipContainer.style.transform = "translateX(0)";
  }

  function hideTooltip() {
    activeTooltipButton = null;
    tooltipContainer.style.opacity = "0";
    tooltipContainer.style.transform = "translateX(-10px)";
  }

  function addHoverEffect(button, text) {
    if (!button) return;
    if (button.hasAttribute("title")) button.removeAttribute("title");
    button.addEventListener("mouseenter", () => {
      const label = typeof text === "function" ? text() : text;
      button.dataset.title = label;
      showTooltip(button, label);
      button.style.transform = "scale(1.1)";
      button.style.background = "rgba(255,255,255,1)";
    });
    button.addEventListener("mousemove", () => {
      const rect = button.getBoundingClientRect();
      const topPosition = rect.top + (rect.height - customTooltip.offsetHeight) / 2;
      tooltipContainer.style.left = `${rect.left - customTooltip.offsetWidth - 15}px`;
      tooltipContainer.style.top = `${topPosition}px`;
    });
    button.addEventListener("mouseleave", () => {
      hideTooltip();
      button.style.transform = "scale(1)";
      button.style.background = "rgba(255,255,255,0.95)";
    });
  }

  function bindTapEvent(element, callback) {
    if (!element) return;
    let touchMoved = false;
    element.addEventListener("touchstart", () => {
      touchMoved = false;
    }, { passive: true });
    element.addEventListener("touchmove", () => {
      touchMoved = true;
    }, { passive: true });
    element.addEventListener("touchend", (event) => {
      if (!touchMoved) {
        event.preventDefault();
        event.stopPropagation();
        callback(event);
      }
    }, { passive: false });
    element.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      callback(event);
    });
  }

  function wsUrl(path) {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(path, `${protocol}//${window.location.host}`);
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }

  async function api(path) {
    const url = new URL(path, window.location.origin);
    if (token) url.searchParams.set("token", token);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(url.toString(), { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  function setIgnoreMouseEvents(ignore, options) {
    if (window.electronAPI?.setIgnoreMouseEvents) {
      void window.electronAPI.setIgnoreMouseEvents(ignore, options);
    }
  }

  function initPixi() {
    if (!window.PIXI) throw new Error("PIXI 未加载");
    const width = window.innerWidth || 540;
    const height = window.innerHeight || 540;
    app = new PIXI.Application({
      width,
      height,
      backgroundAlpha: 0,
      antialias: false,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    container.appendChild(app.view);
    app.view.style.display = "block";
    app.view.style.width = "100%";
    app.view.style.height = "100%";
    app.view.style.pointerEvents = "none";
    window.addEventListener("resize", () => {
      app.renderer.resize(window.innerWidth, window.innerHeight);
    });
    sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
    sprite.anchor.set(0.5);
    app.stage.addChild(sprite);
    try {
      sprite.filters = [new PIXI.Filter(bgFilterVert, bgFilterFrag, { uThreshold: BG_THRESHOLD })];
    } catch {
      // 绿幕滤镜失败时仍保留原始帧显示。
    }
  }

  let framePending = false;
  let lastFrameAt = 0;

  function updateSprite(texture) {
    if (!sprite || !app || !app.screen.width) return false;
    sprite.texture = texture;
    sprite.x = app.screen.width / 2;
    sprite.y = app.screen.height / 2;
    const sw = app.screen.width / texture.width;
    const sh = app.screen.height / texture.height;
    sprite.scale.set(Math.min(sw, sh));
    return true;
  }

  function connectRender() {
    renderWs = new WebSocket(wsUrl("/ws/tha"));
    renderWs.binaryType = "arraybuffer";
    renderWs.onopen = () => {
      connected = true;
      framePending = false;
      updateWsStatus();
    };
    renderWs.onmessage = (event) => {
      if (typeof event.data === "string") {
        handleRenderTextMessage(event.data);
        return;
      }
      if (!(event.data instanceof ArrayBuffer)) return;
      if (framePending) return;
      const now = performance.now();
      if (now - lastFrameAt < 14) return;
      lastFrameAt = now;
      framePending = true;
      createImageBitmap(new Blob([event.data], { type: "image/jpeg" }))
        .then((bitmap) => {
          framePending = false;
          if (!sprite || !app) {
            bitmap.close();
            return;
          }
          const oldTexture = sprite.texture;
          const texture = PIXI.Texture.from(bitmap);
          const updated = updateSprite(texture);
          if (updated && oldTexture && oldTexture !== PIXI.Texture.WHITE) {
            oldTexture.destroy(true);
          } else if (!updated) {
            texture.destroy(true);
          }
        })
        .catch((error) => {
          framePending = false;
          console.error("[THA] ImageBitmap decode failed:", error);
        });
    };
    renderWs.onclose = () => {
      connected = false;
      updateWsStatus();
      setTimeout(connectRender, 3000);
    };
    renderWs.onerror = () => renderWs && renderWs.close();
  }

  function disconnectRender() {
    if (!renderWs) return;
    renderWs.onclose = null;
    renderWs.close();
    renderWs = null;
    connected = false;
    updateWsStatus();
  }

  function connectEvents() {
    eventsWs = new WebSocket(wsUrl("/ws/tha-events"));
    eventsWs.onopen = () => {
      eventsConnected = true;
      updateWsStatus();
    };
    eventsWs.onclose = () => {
      eventsConnected = false;
      updateWsStatus();
      setTimeout(connectEvents, 3000);
    };
    eventsWs.onerror = () => eventsWs && eventsWs.close();
    eventsWs.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "audio") enqueueAudioEvent(payload);
        else if (payload.type === "assistant_audio_start") startPcmStream(payload.audio || {});
        else if (payload.type === "assistant_audio_chunk") appendPcmChunk(payload.audio || {});
        else if (payload.type === "assistant_audio_end") endPcmStream(payload.audio || {});
        else if (payload.type === "assistant_audio_error") failPcmStream(payload.audio || {});
      } catch (error) {
        console.error("[THA] event parse failed:", error);
      }
    };
  }

  function disconnectEvents() {
    if (!eventsWs) return;
    eventsWs.onclose = null;
    eventsWs.close();
    eventsWs = null;
    eventsConnected = false;
    updateWsStatus();
  }

  function handleRenderTextMessage(raw) {
    try {
      const message = JSON.parse(raw);
      if (message.type === "pong" && message.sentAt) {
        const rtt = performance.now() - Number(message.sentAt);
        probeBtn.dataset.title = `RTT ${Math.round(rtt)}ms`;
        if (tooltipContainer.style.opacity === "1") {
          customTooltip.textContent = probeBtn.dataset.title;
        }
      } else if (message.type === "subtitle") {
        renderSubtitle(String(message.text || ""));
      } else if (message.type === "error") {
        console.error("[THA]", message.message || "render error");
      }
    } catch {
      console.warn("[THA]", raw);
    }
  }

  function sendControl(payload) {
    if (!renderWs || renderWs.readyState !== WebSocket.OPEN) return;
    renderWs.send(JSON.stringify(payload));
  }

  function updateWsStatus() {
    if (!wsStatusBtn) return;
    const icon = wsStatusBtn.querySelector("i");
    const online = connected && eventsConnected;
    if (icon) icon.style.color = online ? "#28a745" : "#dc3545";
    wsStatusBtn.dataset.title = online ? LABELS.connected : LABELS.disconnected;
    if (
      activeTooltipButton === wsStatusBtn &&
      tooltipContainer.style.opacity === "1"
    ) {
      customTooltip.textContent = wsStatusBtn.dataset.title;
    }
  }

  document.addEventListener("mousemove", (event) => {
    const rect = container.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const maxDistance = Math.max(window.innerWidth, window.innerHeight);
    mx = ((event.clientX - cx) / maxDistance) * 2;
    my = ((event.clientY - cy) / maxDistance) * 2;
    if (isAutoHideEnabled && !isLocked && !isModelHiddenByHover && !isPanelHovered && app?.view) {
      isModelHiddenByHover = true;
      app.view.style.transition = "opacity 150ms ease";
      app.view.style.opacity = "0";
    }
  });

  document.addEventListener("mouseleave", () => {
    mx = 0;
    my = 0;
    if (isAutoHideEnabled && isModelHiddenByHover && app?.view) {
      isModelHiddenByHover = false;
      app.view.style.transition = "opacity 150ms ease";
      app.view.style.opacity = "1";
    }
  });

  setInterval(() => {
    sendControl({ type: "mouse", x: mx.toFixed(3), y: my.toFixed(3) });
  }, 33);

  function showPanel() {
    clearTimeout(hideTimeout);
    controlPanel.classList.remove("hidden");
    controlPanel.style.opacity = "1";
    controlPanel.style.transform = "translateX(0)";
  }

  function hidePanel() {
    if (!isPanelHovered) {
      controlPanel.classList.add("hidden");
      controlPanel.style.opacity = "0";
      controlPanel.style.transform = "translateX(20px)";
    }
  }

  function scheduleHide() {
    clearTimeout(hideTimeout);
    hideTimeout = setTimeout(hidePanel, isLocked ? 200 : 1200);
  }

  document.body.addEventListener("mouseenter", showPanel);
  document.body.addEventListener("mousemove", () => {
    showPanel();
    scheduleHide();
  });
  document.body.addEventListener("mouseleave", () => {
    if (!isPanelHovered) scheduleHide();
  });
  document.body.addEventListener("touchstart", (event) => {
    if (!controlPanel.contains(event.target)) {
      showPanel();
      scheduleHide();
    }
  }, { passive: true });
  controlPanel.addEventListener("mouseenter", () => {
    isPanelHovered = true;
    clearTimeout(hideTimeout);
    showPanel();
    if (isLocked) setIgnoreMouseEvents(false);
    if (isAutoHideEnabled && !isLocked && isModelHiddenByHover && app?.view) {
      isModelHiddenByHover = false;
      app.view.style.transition = "opacity 150ms ease";
      app.view.style.opacity = "1";
    }
  });
  controlPanel.addEventListener("mouseleave", () => {
    isPanelHovered = false;
    scheduleHide();
    if (isLocked) setIgnoreMouseEvents(true, { forward: true });
    if (isAutoHideEnabled && !isLocked && !isModelHiddenByHover && app?.view) {
      isModelHiddenByHover = true;
      app.view.style.transition = "opacity 150ms ease";
      app.view.style.opacity = "0";
    }
  });
  scheduleHide();

  function renderSubtitle(text) {
    if (!subtitleEl || !isSubtitleEnabled) return;
    subtitleEl.textContent = text;
    subtitleEl.style.opacity = text ? "1" : "0";
  }

  function clearSubtitle() {
    if (!subtitleEl) return;
    subtitleEl.style.transition = "opacity 0.5s ease";
    subtitleEl.style.opacity = "0";
  }

  function parseExpressions(text) {
    const expressions = [];
    const clean = String(text || "")
      .replace(/<([^>]+)>/g, (_match, tag) => {
        const normalized = String(tag).trim();
        if (normalized) expressions.push(normalized);
        return "";
      })
      .trim();
    return { expressions, clean };
  }

  function applyExpressions(expressions) {
    if (!expressions.length) {
      sendControl({ type: "emotion", emotion: "neutral" });
      return;
    }
    for (const expression of expressions) {
      if (motionTags.has(expression)) {
        sendControl({ type: "motion", motion: expression });
      } else {
        sendControl({ type: "emotion", emotion: expression });
      }
    }
  }

  function resetEmotionToNeutral() {
    sendControl({ type: "emotion", emotion: "neutral" });
    sendControl({ type: "motionClear" });
  }

  function enqueueAudioEvent(payload) {
    const media = Array.isArray(payload.media) ? payload.media : [];
    const { expressions, clean } = parseExpressions(payload.text || "");
    for (const item of media) {
      if (!item || !item.url) continue;
      audioQueue.push({ url: item.url, name: item.name || "", text: clean, expressions });
    }
    drainAudioQueue();
  }

  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  }

  async function fetchAudioArrayBuffer(url) {
    const resolved = new URL(url, window.location.origin);
    if (token) resolved.searchParams.set("token", token);
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(resolved.toString(), { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.arrayBuffer();
  }

  function startMouthTracking(source) {
    stopMouthTracking();
    const context = getAudioCtx();
    audioAnalyser = context.createAnalyser();
    audioAnalyser.fftSize = 512;
    audioAnalyser.smoothingTimeConstant = 0;
    source.connect(audioAnalyser);

    const data = new Uint8Array(audioAnalyser.frequencyBinCount);
    const sampleRate = context.sampleRate;
    let lastSendTime = 0;

    function trackLoop() {
      if (!audioAnalyser) return;
      mouthTimer = requestAnimationFrame(trackLoop);
      const now = performance.now();
      if (now - lastSendTime < 33) return;
      audioAnalyser.getByteFrequencyData(data);

      const startBin = Math.floor((200 / (sampleRate / 2)) * data.length);
      const endBin = Math.floor((3000 / (sampleRate / 2)) * data.length);
      let vocalEnergy = 0;
      for (let i = startBin; i < endBin; i += 1) vocalEnergy += data[i];
      const avgVol = vocalEnergy / Math.max(endBin - startBin, 1);

      let amp = 0;
      const noiseGate = 12;
      if (avgVol > noiseGate) {
        const baseIntensity = Math.min(1, (avgVol - noiseGate) / 35);
        const modulation = 0.5 + 0.5 * Math.sin(now * 0.03);
        amp = Math.min(1, baseIntensity * (0.3 + 0.7 * modulation));
      }
      sendControl({ type: "mouth", amplitude: amp.toFixed(3) });
      lastSendTime = now;
    }
    trackLoop();
  }

  function stopMouthTracking() {
    if (mouthTimer) {
      cancelAnimationFrame(mouthTimer);
      mouthTimer = null;
    }
    sendControl({ type: "mouth", amplitude: 0 });
    if (audioAnalyser) {
      audioAnalyser.disconnect();
      audioAnalyser = null;
    }
  }

  function haltCurrentAudio() {
    audioGeneration += 1;
    audioQueue.length = 0;
    if (currentAudioSource) {
      try { currentAudioSource.stop(); } catch (_) { /* 已结束 */ }
      currentAudioSource = null;
    }
    if (pcmStream) {
      pcmStream.sources.forEach((source) => {
        try { source.stop(); } catch (_) { /* 已结束 */ }
      });
      pcmStream = null;
    }
    const context = audioCtx;
    audioCtx = null;
    if (context) {
      void context.close();
    }
    stopMouthTracking();
    resetEmotionToNeutral();
    clearSubtitle();
    setSystemMediaActive(false);
  }

  function decodeBase64Pcm(data) {
    const raw = window.atob(String(data || ""));
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return bytes;
  }

  function pcmToAudioBuffer(context, pcm, sampleRate) {
    const samples = Math.floor(pcm.byteLength / 2);
    const buffer = context.createBuffer(1, samples, sampleRate);
    const output = buffer.getChannelData(0);
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let index = 0; index < samples; index += 1) {
      output[index] = view.getInt16(index * 2, true) / 32768;
    }
    return buffer;
  }

  function finishPcmPlayback(stream) {
    if (pcmStream !== stream || !stream.ended || stream.pending > 0) return;
    pcmStream = null;
    stopMouthTracking();
    resetEmotionToNeutral();
    clearSubtitle();
    setSystemMediaActive(false);
  }

  function startPcmStream(audio) {
    const audioId = String(audio.audioId || "");
    const sampleRate = Number(audio.sampleRate || 24000);
    if (!audioId || !Number.isFinite(sampleRate) || sampleRate <= 0) return;
    haltCurrentAudio();
    const context = getAudioCtx();
    pcmStream = {
      audioId,
      sampleRate,
      expectedSequence: 0,
      nextStartTime: context.currentTime + Math.max(0, Math.min(audioDelayMs, 2000)) / 1000 + 0.03,
      sources: [],
      pending: 0,
      ended: false,
    };
    const parsed = parseExpressions(audio.text || "");
    applyExpressions(parsed.expressions);
    if (parsed.clean) renderSubtitle(parsed.clean);
  }

  function appendPcmChunk(audio) {
    const stream = pcmStream;
    if (!stream || String(audio.audioId || "") !== stream.audioId) return;
    if (Number(audio.sequence) !== stream.expectedSequence) {
      haltCurrentAudio();
      return;
    }
    stream.expectedSequence += 1;
    try {
      const context = getAudioCtx();
      const pcm = decodeBase64Pcm(audio.data);
      const source = context.createBufferSource();
      source.buffer = pcmToAudioBuffer(context, pcm, stream.sampleRate);
      source.connect(context.destination);
      if (!audioAnalyser) startMouthTracking(source);
      else source.connect(audioAnalyser);
      const startsAt = Math.max(context.currentTime + 0.03, stream.nextStartTime);
      stream.nextStartTime = startsAt + source.buffer.duration;
      stream.sources.push(source);
      stream.pending += 1;
      source.onended = () => {
        stream.pending = Math.max(0, stream.pending - 1);
        stream.sources = stream.sources.filter((item) => item !== source);
        finishPcmPlayback(stream);
      };
      source.start(startsAt);
      setSystemMediaActive(true);
    } catch (error) {
      console.error("[THA] PCM playback failed:", error);
      haltCurrentAudio();
    }
  }

  function endPcmStream(audio) {
    const stream = pcmStream;
    if (!stream || String(audio.audioId || "") !== stream.audioId) return;
    stream.ended = true;
    finishPcmPlayback(stream);
  }

  function failPcmStream(audio) {
    if (!pcmStream || String(audio.audioId || "") !== pcmStream.audioId) return;
    haltCurrentAudio();
  }

  async function playQueuedAudio(item, generation) {
    const context = getAudioCtx();
    const data = await fetchAudioArrayBuffer(item.url);
    if (generation !== audioGeneration) return;
    const buffer = await context.decodeAudioData(data.slice(0));
    if (generation !== audioGeneration) return;
    const source = context.createBufferSource();
    currentAudioSource = source;
    const delay = context.createDelay(2.5);
    delay.delayTime.value = Math.max(0, Math.min(audioDelayMs, 2000)) / 1000;
    source.buffer = buffer;
    source.connect(delay);
    delay.connect(context.destination);
    applyExpressions(item.expressions);
    if (item.text) renderSubtitle(item.text);
    startMouthTracking(source);
    await setSystemMediaActive(true);
    if (generation !== audioGeneration) return;
    await new Promise((resolve) => {
      source.onended = () => {
        if (currentAudioSource === source) currentAudioSource = null;
        resolve();
      };
      source.start();
    });
    stopMouthTracking();
    resetEmotionToNeutral();
    clearSubtitle();
  }

  async function drainAudioQueue() {
    if (isPlayingAudio) return;
    const generation = audioGeneration;
    isPlayingAudio = true;
    try {
      while (audioQueue.length && generation === audioGeneration) {
        const item = audioQueue.shift();
        try {
          await playQueuedAudio(item, generation);
        } catch (error) {
          console.error("[THA] audio playback failed:", error);
        }
      }
    } finally {
      isPlayingAudio = false;
      setTimeout(() => {
        if (!isPlayingAudio && audioQueue.length === 0 && !pcmStream) {
          setSystemMediaActive(false);
        }
      }, Math.max(0, audioDelayMs));
      if (audioQueue.length > 0) drainAudioQueue();
    }
  }

  bindTapEvent(lockBtn, () => {
    isLocked = !isLocked;
    if (isLocked) {
      setIgnoreMouseEvents(true, { forward: true });
      controlPanel.querySelectorAll(".ctrl-btn").forEach((button) => {
        if (button !== lockBtn) button.style.display = "none";
      });
    } else {
      setIgnoreMouseEvents(false);
      controlPanel.querySelectorAll(".ctrl-btn").forEach((button) => {
        button.style.display = "flex";
      });
    }
    const icon = lockBtn.querySelector("i");
    if (icon) icon.className = isLocked ? "fas fa-lock" : "fas fa-lock-open";
    lockBtn.style.color = isLocked ? "#dc3545" : "#28a745";
    lockBtn.dataset.title = isLocked ? LABELS.unlockWindow : LABELS.lockWindow;
    if (tooltipContainer.style.opacity === "1") customTooltip.textContent = lockBtn.dataset.title;
  });

  bindTapEvent(hideBtn, () => {
    isAutoHideEnabled = !isAutoHideEnabled;
    const icon = hideBtn.querySelector("i");
    if (isAutoHideEnabled) {
      if (icon) icon.className = "fas fa-eye-slash";
      hideBtn.style.color = "#ffc107";
    } else {
      if (icon) icon.className = "fas fa-eye";
      hideBtn.style.color = "#6c757d";
      if (app?.view) app.view.style.opacity = "1";
      isModelHiddenByHover = false;
    }
    hideBtn.dataset.title = isAutoHideEnabled
      ? LABELS.autoHideEnabled
      : LABELS.autoHideDescription;
    if (tooltipContainer.style.opacity === "1") customTooltip.textContent = hideBtn.dataset.title;
  });

  bindTapEvent(subtitleBtn, () => {
    isSubtitleEnabled = !isSubtitleEnabled;
    if (subtitleEl) subtitleEl.style.display = isSubtitleEnabled ? "block" : "none";
    subtitleBtn.style.color = isSubtitleEnabled ? "#28a745" : "#dc3545";
    if (!isSubtitleEnabled) clearSubtitle();
    subtitleBtn.dataset.title = isSubtitleEnabled
      ? LABELS.subtitleEnabled
      : LABELS.subtitleDisabled;
    if (tooltipContainer.style.opacity === "1") {
      customTooltip.textContent = subtitleBtn.dataset.title;
    }
  });

  bindTapEvent(wsStatusBtn, () => {
    disconnectRender();
    disconnectEvents();
    haltCurrentAudio();
    setTimeout(() => {
      connectRender();
      connectEvents();
    }, 500);
  });

  bindTapEvent(probeBtn, () => {
    sendControl({ type: "ping", sentAt: performance.now() });
  });

  bindTapEvent(refreshBtn, () => location.reload());
  bindTapEvent(closeBtn, () => window.close());

  addHoverEffect(lockBtn, () => (isLocked ? LABELS.unlockWindow : LABELS.lockWindow));
  addHoverEffect(hideBtn, () =>
    isAutoHideEnabled ? LABELS.autoHideEnabled : LABELS.autoHideDescription
  );
  addHoverEffect(subtitleBtn, () =>
    isSubtitleEnabled ? LABELS.subtitleEnabled : LABELS.subtitleDisabled
  );
  addHoverEffect(refreshBtn, LABELS.refreshWindow);
  addHoverEffect(closeBtn, LABELS.closeWindow);
  addHoverEffect(dragBtn, LABELS.dragWindow);
  addHoverEffect(wsStatusBtn, () => wsStatusBtn.dataset.title || LABELS.disconnected);
  addHoverEffect(probeBtn, LABELS.probeLatency);

  setInterval(updateWsStatus, 1000);

  async function loadModelStatus() {
    const data = await api("/api/tha");
    audioDelayMs = Number(data.config?.audioDelayMs ?? 150);
    if (!data.model?.available) {
      console.warn("[THA] model not found:", data.model?.path);
    }
  }

  try {
    initPixi();
  } catch (error) {
    console.error("[THA] PixiJS init failed:", error);
  }

  if (!token) {
    console.warn("[THA] missing token; open from settings to attach credentials");
  }

  if (app) {
    connectRender();
    connectEvents();
    void loadModelStatus();
  }
})();
