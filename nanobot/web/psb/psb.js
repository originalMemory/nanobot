(function () {
  'use strict';

  var DEFAULT_TIMELINE = '待機';
  var EXPRESSION_MS = 300;
  var EXPRESSION_EASING = -1;
  var FACE_VAR_PATTERN = /^face_|^arm_type$/;
  var FADE_VAR_PATTERN = /^fade_/;
  var TRACK_MODULE = 'eyetrack';
  var TRACK = {
    eyeMs: 500,
    headMs: 1000,
    bodyMs: 2000,
    headThreshold: 60,
    bodyThreshold: 120,
    easing: -1,
  };

  var params = new URLSearchParams(window.location.search);
  var gatewayToken = params.get('token') || '';
  var modelId = params.get('modelId') || '';

  var canvas = document.getElementById('canvas');
  var controlPanel = document.getElementById('control-panel');
  var statusEl = document.getElementById('status');
  var closeBtn = document.getElementById('close-btn');
  var closePermanentBtn = document.getElementById('close-permanent-btn');
  var configBtn = document.getElementById('config-btn');
  var scaleBtn = document.getElementById('scale-btn');
  var scaleRow = document.getElementById('scale-row');
  var opacityBtn = document.getElementById('opacity-btn');
  var opacityRow = document.getElementById('opacity-row');
  var trackBtn = document.getElementById('track-btn');
  var scaleRange = document.getElementById('scale-range');
  var scaleVal = document.getElementById('scale-val');
  var opacityRange = document.getElementById('opacity-range');
  var opacityVal = document.getElementById('opacity-val');
  var dragBtn = document.getElementById('drag-btn');

  var player = null;
  var modelMetadata = null;
  var initialLoopTimeline = '';
  var savedInitialState = null;
  var transientTimeline = '';
  var controlsBound = false;
  var faceTrackingBound = false;
  var faceTrackingEnabled = true;
  var panelHovered = false;
  var inHotZone = false;
  var scaleExpanded = false;
  var opacityExpanded = false;
  var windowDragging = false;
  var lastMouseX = 0;
  var lastMouseY = 0;
  var panelHideTimer = null;
  var PANEL_HIDE_DELAY_MS = 1200;
  var metadataSyncPromise = null;
  var timelineWatchTimer = null;
  var electronApi = window.electronAPI && window.electronAPI.psb;
  var eventsWs = null;
  var audioQueue = [];
  var isPlayingAudio = false;
  var pendingStreamEnd = false;
  var pendingRuntimeActions = [];

  function setStatus(text, isError) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.className = isError ? 'error' : '';
    statusEl.hidden = !text;
  }

  function formatError(err) {
    if (err == null) return '未知错误';
    if (typeof err === 'number') return 'WASM 运行时异常（代码 ' + err + '）';
    if (typeof err === 'string') return err;
    if (err.message) return err.message;
    return String(err);
  }

  function authHeaders() {
    var headers = {};
    if (gatewayToken) headers.Authorization = 'Bearer ' + gatewayToken;
    return headers;
  }

  function apiUrl(path) {
    return new URL(path, window.location.origin).toString();
  }

  function fetchJson(path) {
    if (window.PsbHttp && typeof window.PsbHttp.fetchJson === 'function') {
      return window.PsbHttp.fetchJson(path, gatewayToken);
    }
    return fetch(apiUrl(path), { headers: authHeaders() }).then(function (res) {
      var contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      var readBody =
        String(contentType).toLowerCase().indexOf('application/json') !== -1
          ? res.json()
          : res.text();
      return readBody.then(function (body) {
        if (!res.ok) {
          var message =
            body && typeof body === 'object'
              ? body.message || body.error
              : String(body || '').trim();
          throw new Error(message || ('HTTP ' + res.status));
        }
        if (typeof body === 'string') return JSON.parse(body);
        return body;
      });
    });
  }

  function fetchBytes(path) {
    return fetch(apiUrl(path), { headers: authHeaders() }).then(function (res) {
      if (!res.ok) throw new Error('下载模型失败（HTTP ' + res.status + '）');
      return res.arrayBuffer().then(function (buf) {
        return new Uint8Array(buf);
      });
    });
  }

  function fetchAudioArrayBuffer(path) {
    return fetch(apiUrl(path), { headers: authHeaders() }).then(function (res) {
      if (!res.ok) throw new Error('下载音频失败（HTTP ' + res.status + '）');
      return res.arrayBuffer();
    });
  }

  function wsUrl(path) {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    var url = new URL(path, proto + '//' + window.location.host);
    if (gatewayToken) url.searchParams.set('token', gatewayToken);
    return url.toString();
  }

  function setFollowMouseEnabled(enabled) {
    faceTrackingEnabled = !!enabled;
    if (trackBtn) {
      trackBtn.style.color = faceTrackingEnabled ? '#28a745' : '#999';
      trackBtn.title = faceTrackingEnabled ? '鼠标追踪已开启' : '鼠标追踪已关闭';
    }
    if (!faceTrackingEnabled) clearFaceTracking();
  }

  function parseTagExpressions(text) {
    var expressions = [];
    var clean = String(text || '')
      .replace(/<([^>]+)>/g, function (_match, tag) {
        var normalized = String(tag).trim();
        if (normalized) expressions.push(normalized);
        return '';
      })
      .trim();
    return { expressions: expressions, clean: clean };
  }

  function enqueueAudioEvent(payload) {
    var media = Array.isArray(payload.media) ? payload.media : [];
    var parsed = parseTagExpressions(payload.text || '');
    media.forEach(function (item) {
      if (!item || !item.url) return;
      audioQueue.push({
        url: item.url,
        expressions: parsed.expressions,
      });
    });
    drainAudioQueue();
  }

  async function playQueuedAudio(item) {
    if (!window.EmoteTalkSync || !player || !player.initialized) return;
    if (!EmoteTalkSync.hasFaceTalk(player)) return;
    var data = await fetchAudioArrayBuffer(item.url);
    item.expressions.forEach(function (name) {
      applyExpressionByName(name);
    });
    await EmoteTalkSync.playArrayBuffer(data, player);
    restoreTransientState();
  }

  async function drainAudioQueue() {
    if (isPlayingAudio) return;
    isPlayingAudio = true;
    try {
      while (audioQueue.length) {
        var item = audioQueue.shift();
        try {
          await playQueuedAudio(item);
        } catch (err) {
          console.error('[psb] audio playback failed:', err);
        }
      }
    } finally {
      isPlayingAudio = false;
      if (pendingStreamEnd && audioQueue.length === 0) {
        pendingStreamEnd = false;
        restoreAfterStreamEnd();
      }
    }
  }

  function connectEvents() {
    if (eventsWs) return;
    eventsWs = new WebSocket(wsUrl('/ws/tha-events'));
    eventsWs.onmessage = function (event) {
      if (typeof event.data !== 'string') return;
      try {
        var payload = JSON.parse(event.data);
        if (payload.type === 'audio') enqueueAudioEvent(payload);
      } catch (err) {
        console.error('[psb] event parse failed:', err);
      }
    };
    eventsWs.onclose = function () {
      eventsWs = null;
      setTimeout(connectEvents, 3000);
    };
    eventsWs.onerror = function () {
      if (eventsWs) eventsWs.close();
    };
  }

  function disconnectEvents() {
    if (!eventsWs) return;
    eventsWs.onclose = null;
    eventsWs.close();
    eventsWs = null;
  }

  function isFaceVariable(label) {
    return FACE_VAR_PATTERN.test(label);
  }

  function isFadeVariable(label) {
    return FADE_VAR_PATTERN.test(label);
  }

  function findFrameByPresetName(frameList, presetName) {
    if (!frameList || !frameList.length) return null;
    var alias = {
      通常: [/通常/, /^normal$/i],
      怒: [/怒/],
      笑: [/笑/],
      びっくり: [/びっくり/, /驚/, /驚き/],
    };
    var patterns = alias[presetName] || [new RegExp(presetName)];
    for (var i = 0; i < patterns.length; i++) {
      var frame = frameList.find(function (f) {
        return patterns[i].test(f.label);
      });
      if (frame) return frame;
    }
    return null;
  }

  function applyVariableMap(values, ms, easing) {
    if (!player || !player.initialized) return;
    Object.keys(values).forEach(function (label) {
      player.setVariable(label, values[label], ms, easing);
    });
  }

  function applyExpressionByName(name) {
    if (!player || !player.initialized) return;
    var variableList = player.variableList || [];
    var values = {};
    variableList.filter(function (v) { return isFaceVariable(v.label); }).forEach(function (variable) {
      var frame = findFrameByPresetName(variable.frameList, name);
      if (frame) values[variable.label] = frame.value;
    });
    if (Object.keys(values).length === 0) return;
    applyVariableMap(values, EXPRESSION_MS, EXPRESSION_EASING);
  }

  function applyExpressionFaceFadeFromState(state) {
    if (!player || !player.initialized || !state) return;
    if (state.expression) applyExpressionByName(state.expression);
    if (state.face && typeof state.face === 'object') {
      applyVariableMap(state.face, EXPRESSION_MS, EXPRESSION_EASING);
    }
    if (state.fade && typeof state.fade === 'object') {
      applyVariableMap(state.fade, EXPRESSION_MS, EXPRESSION_EASING);
    }
  }

  function restoreExpressionFaceFade() {
    applyExpressionFaceFadeFromState(savedInitialState || {});
  }

  function applyInitialState(state) {
    if (!player || !player.initialized || !state) return;
    applyExpressionFaceFadeFromState(state);
    var timeline = state.timeline || initialLoopTimeline;
    if (timeline) {
      player.mainTimelineLabel = timeline;
      player.playTimeline(timeline);
    }
  }

  function restoreTransientState() {
    if (!player || !player.initialized) return;
    restoreExpressionFaceFade();
    transientTimeline = '';
    var timeline = (savedInitialState && savedInitialState.timeline) || initialLoopTimeline;
    if (timeline) {
      player.mainTimelineLabel = timeline;
      player.playTimeline(timeline);
    }
  }

  function restoreAfterStreamEnd() {
    restoreExpressionFaceFade();
  }

  function startTimelineWatch() {
    if (timelineWatchTimer) return;
    timelineWatchTimer = setInterval(function () {
      if (!player || !player.initialized || !transientTimeline) return;
      if (!player.animating) {
        transientTimeline = '';
        restoreTransientState();
      }
    }, 120);
  }

  function playTimelineAction(label, looping) {
    if (!player || !player.initialized || !label) return;
    if (looping) {
      transientTimeline = '';
      player.mainTimelineLabel = label;
      player.playTimeline(label);
      return;
    }
    transientTimeline = label;
    player.playTimeline(label);
    startTimelineWatch();
  }

  function requestRestoreAfterStreamEnd() {
    if (isPlayingAudio || audioQueue.length > 0) {
      pendingStreamEnd = true;
      return;
    }
    restoreAfterStreamEnd();
  }

  function requestRestoreTransientState() {
    if (isPlayingAudio || audioQueue.length > 0) {
      pendingStreamEnd = true;
      return;
    }
    restoreTransientState();
  }

  function drainPendingRuntimeActions() {
    if (!player || !player.initialized || pendingRuntimeActions.length === 0) return;
    var queued = pendingRuntimeActions.slice();
    pendingRuntimeActions = [];
    queued.forEach(function (action) {
      handleRuntimeAction(action);
    });
  }

  function handleRuntimeAction(action) {
    var normalized = window.PsbActions && window.PsbActions.normalizeAction(action);
    if (!normalized) return;
    var type = normalized.type;
    var payload = normalized.payload;

    if (type === 'restore-initial') {
      requestRestoreTransientState();
      return;
    }

    if (type === 'stream-end') {
      requestRestoreAfterStreamEnd();
      return;
    }

    if (!player || !player.initialized) {
      pendingRuntimeActions.push(action);
      return;
    }

    if (type === 'timeline' || type === 'psb:timeline') {
      var picked = window.PsbActions.pickTimelineLabel(payload, modelMetadata);
      if (!picked.ok) {
        console.warn('[psb]', picked.error);
        return;
      }
      playTimelineAction(picked.label, picked.looping);
      return;
    }

    if (type === 'expression' || type === 'psb:expression') {
      var expr = window.PsbActions.pickExpressionLabel(payload, modelMetadata);
      if (!expr.ok) {
        console.warn('[psb]', expr.error);
        return;
      }
      applyExpressionByName(expr.label);
      return;
    }

    if (type === 'face' || type === 'psb:face') {
      var face = window.PsbActions.pickFaceUpdate(payload, modelMetadata);
      if (!face.ok) {
        console.warn('[psb]', face.error);
        return;
      }
      player.setVariable(face.label, face.value, EXPRESSION_MS, EXPRESSION_EASING);
      return;
    }

    if (type === 'fade' || type === 'psb:fade') {
      var fade = window.PsbActions.pickFadeUpdate(payload, modelMetadata);
      if (!fade.ok) {
        console.warn('[psb]', fade.error);
        return;
      }
      player.setVariable(fade.label, fade.value, EXPRESSION_MS, EXPRESSION_EASING);
    }
  }

  function formatOpacityLabel(value) {
    return Math.round(value * 100) + '%';
  }

  function applyOpacity(value) {
    var next = Number(value);
    if (!Number.isFinite(next)) return;
    if (opacityRange) opacityRange.value = String(next);
    if (opacityVal) opacityVal.textContent = formatOpacityLabel(next);
  }

  function readScaleFromUi() {
    if (!scaleRange) return 0.45;
    var parsed = parseFloat(scaleRange.value);
    return Number.isFinite(parsed) ? parsed : 0.45;
  }

  function applyScale(value) {
    var next = Number(value);
    if (!Number.isFinite(next)) return;
    if (scaleRange) scaleRange.value = String(next);
    if (scaleVal) scaleVal.textContent = String(next);
    if (player) player.scale = next;
  }

  function applyStoredWindowState(state) {
    if (!state) return;
    if (state.opacity !== undefined) applyOpacity(state.opacity);
    if (state.scale !== undefined) applyScale(state.scale);
  }

  function setMousePassthrough(enabled) {
    if (!electronApi || typeof electronApi.setIgnoreMouseEvents !== 'function') return;
    if (enabled) {
      electronApi.setIgnoreMouseEvents(true, { forward: true });
      return;
    }
    electronApi.setIgnoreMouseEvents(false);
  }

  function updateMousePassthrough() {
    var configOpen = window.PsbConfigPanel && window.PsbConfigPanel.isOpen();
    setMousePassthrough(!(panelHovered || configOpen || windowDragging));
  }

  function isPointInRect(x, y, rect) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function isPointOverControlPanel(x, y) {
    if (!controlPanel || controlPanel.classList.contains('hidden')) return false;
    var targets = [controlPanel];
    if (scaleRow && !scaleRow.classList.contains('hidden')) targets.push(scaleRow);
    if (opacityRow && !opacityRow.classList.contains('hidden')) targets.push(opacityRow);
    for (var i = 0; i < targets.length; i++) {
      if (isPointInRect(x, y, targets[i].getBoundingClientRect())) return true;
    }
    return false;
  }

  function syncControlPanelHover(x, y) {
    if (windowDragging) {
      panelHovered = true;
      return;
    }
    panelHovered = isPointOverControlPanel(x, y);
  }

  function startWindowDragFromEvent(e) {
    windowDragging = true;
    panelHovered = true;
    setMousePassthrough(false);
    if (electronApi && typeof electronApi.startWindowDrag === 'function') {
      electronApi.startWindowDrag(e.screenX, e.screenY);
    }
    if (dragBtn && dragBtn.setPointerCapture && e.pointerId !== undefined) {
      try {
        dragBtn.setPointerCapture(e.pointerId);
      } catch (err) {
        // ignore capture failures
      }
    }
  }

  function stopWindowDragFromEvent() {
    if (!windowDragging) return;
    windowDragging = false;
    if (electronApi && typeof electronApi.stopWindowDrag === 'function') {
      electronApi.stopWindowDrag();
    }
    syncControlPanelHover(lastMouseX, lastMouseY);
    updateMousePassthrough();
  }

  function bindRuntimeIpc() {
    if (!electronApi) return;
    if (typeof electronApi.onAction === 'function') {
      electronApi.onAction(handleRuntimeAction);
    }
    if (typeof electronApi.onConfig === 'function') {
      electronApi.onConfig(function (config) {
        if (config.followMouse !== undefined) {
          setFollowMouseEnabled(!!config.followMouse);
        }
        if (config.scale !== undefined) {
          applyScale(config.scale);
        }
        if (config.opacity !== undefined) {
          applyOpacity(Number(config.opacity));
        }
      });
    }
    if (typeof electronApi.onMouse === 'function') {
      electronApi.onMouse(function (point) {
        if (point && point.leave) {
          if (faceTrackingEnabled) clearFaceTracking();
          return;
        }
        if (typeof point.x === 'number' && typeof point.y === 'number') {
          applyFaceTracking(point.x, point.y);
        }
      });
    }
  }

  function hideExpandedRows() {
    scaleExpanded = false;
    opacityExpanded = false;
    if (scaleRow) scaleRow.classList.add('hidden');
    if (opacityRow) opacityRow.classList.add('hidden');
  }

  function toggleScaleRow() {
    scaleExpanded = !scaleExpanded;
    if (scaleExpanded) {
      opacityExpanded = false;
      if (opacityRow) opacityRow.classList.add('hidden');
    }
    if (scaleRow) scaleRow.classList.toggle('hidden', !scaleExpanded);
    updateControlPanelVisibility();
    updateMousePassthrough();
  }

  function toggleOpacityRow() {
    opacityExpanded = !opacityExpanded;
    if (opacityExpanded) {
      scaleExpanded = false;
      if (scaleRow) scaleRow.classList.add('hidden');
    }
    if (opacityRow) opacityRow.classList.toggle('hidden', !opacityExpanded);
    updateControlPanelVisibility();
    updateMousePassthrough();
  }

  function shouldKeepControlPanelVisible() {
    var configActive =
      window.PsbConfigPanel &&
      (window.PsbConfigPanel.isOpen() || window.PsbConfigPanel.isHovered());
    return panelHovered || inHotZone || scaleExpanded || opacityExpanded || configActive;
  }

  function showControlPanel() {
    if (!controlPanel) return;
    if (panelHideTimer) {
      clearTimeout(panelHideTimer);
      panelHideTimer = null;
    }
    controlPanel.classList.remove('hidden');
    syncControlPanelHover(lastMouseX, lastMouseY);
    updateMousePassthrough();
  }

  function scheduleHideControlPanel() {
    if (panelHideTimer) clearTimeout(panelHideTimer);
    if (shouldKeepControlPanelVisible()) return;
    panelHideTimer = setTimeout(function () {
      panelHideTimer = null;
      if (shouldKeepControlPanelVisible()) return;
      if (controlPanel) {
        controlPanel.classList.add('hidden');
        hideExpandedRows();
        panelHovered = false;
        updateMousePassthrough();
      }
    }, PANEL_HIDE_DELAY_MS);
  }

  function updateControlPanelVisibility() {
    if (shouldKeepControlPanelVisible()) {
      showControlPanel();
    } else {
      scheduleHideControlPanel();
    }
  }

  function bindConfigPanelOnce() {
    if (!window.PsbConfigPanel) return;
    window.PsbConfigPanel.init({
      getPlayer: function () { return player; },
      getModelMetadata: function () { return modelMetadata; },
      setModelMetadata: function (meta) { modelMetadata = meta; },
      getModelId: function () { return modelId; },
      getSavedInitialState: function () { return savedInitialState; },
      setSavedInitialState: function (state) {
        savedInitialState = state;
        if (state && state.timeline) initialLoopTimeline = state.timeline;
      },
      fetchJson: fetchJson,
      applyExpressionByName: applyExpressionByName,
      applyVariableMap: applyVariableMap,
      playTimelineAction: playTimelineAction,
      ensureModelMetadataReady: ensureModelMetadataReady,
      onPanelHoverChange: function () {
        updateControlPanelVisibility();
        updateMousePassthrough();
      },
    });
  }

  function bindControlsOnce() {
    if (controlsBound) return;
    controlsBound = true;

    document.body.addEventListener('mousemove', function (e) {
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      inHotZone = e.clientY <= 72 || e.clientX >= window.innerWidth - 72;
      syncControlPanelHover(e.clientX, e.clientY);
      updateControlPanelVisibility();
      updateMousePassthrough();
    });

    document.body.addEventListener('mouseleave', function () {
      if (windowDragging) return;
      inHotZone = false;
      panelHovered = false;
      updateControlPanelVisibility();
      updateMousePassthrough();
    });

    if (controlPanel) {
      controlPanel.addEventListener('mouseenter', function () {
        panelHovered = true;
        updateControlPanelVisibility();
        updateMousePassthrough();
      });
      controlPanel.addEventListener('mouseleave', function () {
        if (windowDragging) return;
        syncControlPanelHover(lastMouseX, lastMouseY);
        updateControlPanelVisibility();
        updateMousePassthrough();
      });
    }

    if (dragBtn) {
      dragBtn.addEventListener('pointerdown', function (e) {
        if (e.button !== 0) return;
        startWindowDragFromEvent(e);
        e.preventDefault();
      });
      dragBtn.addEventListener('lostpointercapture', stopWindowDragFromEvent);
    }

    window.addEventListener('pointerup', stopWindowDragFromEvent);
    window.addEventListener('pointercancel', stopWindowDragFromEvent);

    if (scaleBtn) {
      scaleBtn.addEventListener('click', function () {
        toggleScaleRow();
      });
    }

    if (scaleRange) {
      scaleRange.addEventListener('input', function () {
        var value = parseFloat(scaleRange.value);
        if (!Number.isFinite(value)) return;
        applyScale(value);
        if (electronApi && typeof electronApi.saveWindowState === 'function') {
          electronApi.saveWindowState({ scale: value });
        }
      });
    }

    if (opacityBtn) {
      opacityBtn.addEventListener('click', function () {
        toggleOpacityRow();
      });
    }

    if (opacityRange) {
      opacityRange.addEventListener('input', function () {
        var value = parseFloat(opacityRange.value);
        if (!Number.isFinite(value)) return;
        applyOpacity(value);
        if (electronApi && typeof electronApi.saveWindowState === 'function') {
          electronApi.saveWindowState({ opacity: value });
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        if (electronApi && typeof electronApi.close === 'function') electronApi.close();
      });
    }

    if (closePermanentBtn) {
      closePermanentBtn.addEventListener('click', function () {
        if (electronApi && typeof electronApi.closePermanent === 'function') electronApi.closePermanent();
      });
    }

    if (trackBtn) {
      trackBtn.addEventListener('click', function () {
        var next = !faceTrackingEnabled;
        if (electronApi && typeof electronApi.updateFollowMouse === 'function') {
          electronApi.updateFollowMouse(next);
          return;
        }
        setFollowMouseEnabled(next);
      });
    }
  }

  function clearFaceTracking(ms) {
    if (!player || !player.initialized) return;
    var duration = ms == null ? TRACK.eyeMs : ms;
    [
      'face_eye_LR', 'face_eye_UD',
      'head_slant', 'head_LR', 'head_UD',
      'body_slant', 'body_LR', 'body_UD',
    ].forEach(function (label) {
      player.setVariableDiff(TRACK_MODULE, label, 0, duration, TRACK.easing);
    });
  }

  function applyFaceTracking(clientX, clientY) {
    if (!faceTrackingEnabled || !player || !player.initialized) return;
    var eye = player.getMarkerPosition('eye');
    if (!eye) return;
    var dx = clientX - eye.clientX;
    var dy = clientY - eye.clientY;
    var len = Math.sqrt(dx * dx + dy * dy);
    var angle = Math.atan2(dy, dx);
    var c = Math.cos(angle);
    var s = Math.sin(angle);
    player.setVariableDiff(TRACK_MODULE, 'face_eye_LR', (len / 3) * c, TRACK.eyeMs, TRACK.easing);
    player.setVariableDiff(TRACK_MODULE, 'face_eye_UD', (len / 3) * s, TRACK.eyeMs, TRACK.easing);
    if (len > TRACK.headThreshold) {
      player.setVariableDiff(TRACK_MODULE, 'head_slant', (len / 12) * c, TRACK.headMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'head_LR', (len / 6) * c, TRACK.headMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'head_UD', (len / 6) * s, TRACK.headMs, TRACK.easing);
    } else {
      player.setVariableDiff(TRACK_MODULE, 'head_slant', 0, TRACK.headMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'head_LR', 0, TRACK.headMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'head_UD', 0, TRACK.headMs, TRACK.easing);
    }
    if (len > TRACK.bodyThreshold) {
      player.setVariableDiff(TRACK_MODULE, 'body_slant', (len / 18) * c, TRACK.bodyMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'body_LR', (len / 9) * c, TRACK.bodyMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'body_UD', (len / 9) * s, TRACK.bodyMs, TRACK.easing);
    } else {
      player.setVariableDiff(TRACK_MODULE, 'body_slant', 0, TRACK.bodyMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'body_LR', 0, TRACK.bodyMs, TRACK.easing);
      player.setVariableDiff(TRACK_MODULE, 'body_UD', 0, TRACK.bodyMs, TRACK.easing);
    }
  }

  function bindFaceTrackingOnce() {
    if (faceTrackingBound) return;
    faceTrackingBound = true;
    setFollowMouseEnabled(faceTrackingEnabled);
  }

  function resolveInitialLoopTimeline(metadata) {
    var timelines = (metadata && metadata.timelines) || [];
    var initial = metadata && metadata.initialState;
    if (initial && initial.timeline) {
      var picked = timelines.find(function (item) { return item && item.label === initial.timeline && item.looping; });
      if (picked) return picked.label;
    }
    if (timelines.length) {
      var looping = timelines.find(function (item) { return item && item.looping; });
      if (looping) return looping.label;
    }
    var labels = player && player.mainTimelineLabels ? player.mainTimelineLabels.slice() : [];
    if (labels.indexOf(DEFAULT_TIMELINE) >= 0) return DEFAULT_TIMELINE;
    return labels[0] || '';
  }

  function runtimeMetadataUpdatePath(payload) {
    var query = new URLSearchParams();
    query.set('payload', JSON.stringify(payload));
    return (
      '/api/desk-pet/psb/models/' +
      encodeURIComponent(modelId) +
      '/runtime-metadata/update?' +
      query.toString()
    );
  }

  function syncRuntimeMetadata() {
    if (!window.PsbRuntimeMetadata || !player || !player.initialized || !modelId) {
      return Promise.resolve(modelMetadata);
    }
    var original = modelMetadata;
    var runtimeCaps = window.PsbRuntimeMetadata.extract(player, original);
    modelMetadata = window.PsbRuntimeMetadata.merge(original, runtimeCaps);
    if (!(runtimeCaps.timelines || []).length) {
      return Promise.resolve(modelMetadata);
    }
    var compact = window.PsbRuntimeMetadata.compactForServerSync
      ? window.PsbRuntimeMetadata.compactForServerSync(runtimeCaps)
      : runtimeCaps;
    if (
      window.PsbRuntimeMetadata.needsServerSync &&
      !window.PsbRuntimeMetadata.needsServerSync(original, compact)
    ) {
      return Promise.resolve(modelMetadata);
    }
    var chunks = window.PsbRuntimeMetadata.splitCompactForServerSync
      ? window.PsbRuntimeMetadata.splitCompactForServerSync(compact)
      : [compact];
    var chain = Promise.resolve();
    chunks.forEach(function (part) {
      chain = chain.then(function () {
        return fetchJson(runtimeMetadataUpdatePath(part));
      }).then(function (payload) {
        if (payload && payload.model) {
          modelMetadata = payload.model;
        }
      });
    });
    return chain
      .then(function () {
        return modelMetadata;
      })
      .catch(function (err) {
        console.warn('[psb] runtime metadata sync failed:', err);
        return modelMetadata;
      });
  }

  function ensureModelMetadataReady() {
    if (metadataSyncPromise) return metadataSyncPromise;
    metadataSyncPromise = syncRuntimeMetadata().finally(function () {
      metadataSyncPromise = null;
    });
    return metadataSyncPromise;
  }

  function applyLoadedModel(buffer, metadata) {
    modelMetadata = metadata || {};
    savedInitialState = modelMetadata.initialState || null;
    player.mainTimelineLabel = DEFAULT_TIMELINE;
    player.loadData(buffer);
    if (!player.initialized) throw new Error('EmotePlayer 初始化失败');
    if (!player.mainTimelineLabels || player.mainTimelineLabels.length === 0) {
      throw new Error('模型未暴露可用 timeline');
    }
    return ensureModelMetadataReady().then(function () {
      initialLoopTimeline = resolveInitialLoopTimeline(modelMetadata);
      applyScale(readScaleFromUi());
      applyInitialState(savedInitialState || { timeline: initialLoopTimeline });
      if (window.PsbConfigPanel) window.PsbConfigPanel.refresh();
      setStatus('');
      connectEvents();
      drainPendingRuntimeActions();
    });
  }

  function loadModelFromServer(targetModelId) {
    if (!targetModelId) throw new Error('缺少 modelId');
    setStatus('正在加载模型…');
    return fetchJson('/api/desk-pet/psb/models/' + encodeURIComponent(targetModelId) + '/manifest')
      .then(function (manifest) {
        var files = manifest.files || [];
        if (!files.length) throw new Error('模型资源为空');
        var filePath = files[0].path;
        var fileUrl =
          '/api/desk-pet/psb/models/' +
          encodeURIComponent(targetModelId) +
          '/files/' +
          encodeURIComponent(filePath);
        return fetchBytes(fileUrl).then(function (buffer) {
          return applyLoadedModel(buffer, manifest.metadata || {});
        });
      });
  }

  function initPlayer() {
    if (typeof EmotePlayer === 'undefined') {
      throw new Error('EmotePlayer 未加载');
    }
    var width = Math.max(320, window.innerWidth || 540);
    var height = Math.max(320, window.innerHeight || 540);
    EmotePlayer.createRenderCanvas(width, height);
    EmotePlayer.requireDevice();
    player = new EmotePlayer(canvas);
    applyScale(readScaleFromUi());
    player.mainTimelineLabel = DEFAULT_TIMELINE;
  }

  function resizeCanvas() {
    if (!canvas) return;
    canvas.width = Math.max(320, window.innerWidth || 540);
    canvas.height = Math.max(320, window.innerHeight || 540);
  }

  function bootPsbPlayer() {
    try {
      initPlayer();
    } catch (err) {
      setStatus(formatError(err), true);
      return;
    }

    if (!modelId) {
      setStatus('未指定 modelId', true);
      return;
    }

    loadModelFromServer(modelId)
      .then(function () {
        return fetchJson('/api/settings').then(function (payload) {
          var followMouse = payload && payload.deskPet && payload.deskPet.psb
            ? payload.deskPet.psb.followMouse
            : undefined;
          if (followMouse !== undefined) setFollowMouseEnabled(!!followMouse);
        });
      })
      .catch(function (err) {
        console.error(err);
        setStatus(formatError(err), true);
      });
  }

  function start() {
    resizeCanvas();
    bindControlsOnce();
    bindConfigPanelOnce();
    bindRuntimeIpc();
    bindFaceTrackingOnce();
    setMousePassthrough(true);
    updateMousePassthrough();

    var prefsPromise =
      electronApi && typeof electronApi.getWindowState === 'function'
        ? electronApi.getWindowState()
        : Promise.resolve(null);

    prefsPromise
      .then(function (state) {
        applyStoredWindowState(state);
        bootPsbPlayer();
      })
      .catch(function () {
        bootPsbPlayer();
      });
  }

  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('beforeunload', disconnectEvents);
  window.addEventListener('load', start);
})();
