(function (global) {
  'use strict';

  var NOISE_GATE = 12;
  var VOCAL_LOW_HZ = 200;
  var VOCAL_HIGH_HZ = 3000;
  var FACE_TALK_MAX = 5;
  var SMOOTH_FACTOR = 0.35;
  var MIN_INTERVAL_MS = 33;
  var CLOSE_MS = 150;

  var state = {
    audioCtx: null,
    source: null,
    analyser: null,
    rafId: null,
    smoothAmp: 0,
    player: null,
    playing: false,
    lastSendTime: 0,
    onUpdate: null
  };

  function getAudioCtx() {
    if (!state.audioCtx) {
      state.audioCtx = new (global.AudioContext || global.webkitAudioContext)();
    }
    if (state.audioCtx.state === 'suspended') {
      void state.audioCtx.resume();
    }
    return state.audioCtx;
  }

  function hasFaceTalk(player) {
    if (!player || !player.initialized || !player.variableList) return false;
    return player.variableList.some(function (v) { return v.label === 'face_talk'; });
  }

  function applyTalk(player, amp) {
    if (!player || !player.initialized) return;
    player.setVariable('face_talk', amp * FACE_TALK_MAX, 0, 0);
    if (typeof state.onUpdate === 'function') {
      state.onUpdate(amp * FACE_TALK_MAX);
    }
  }

  function stopTracking(resetMouth) {
    if (state.rafId != null) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
    if (state.analyser) {
      try { state.analyser.disconnect(); } catch (e) { /* ignore */ }
      state.analyser = null;
    }
    state.smoothAmp = 0;
    state.lastSendTime = 0;
    if (resetMouth !== false && state.player) {
      state.player.setVariable('face_talk', 0, CLOSE_MS, -1);
      if (typeof state.onUpdate === 'function') {
        state.onUpdate(0);
      }
    }
  }

  function stop() {
    state.playing = false;
    if (state.source) {
      try {
        state.source.onended = null;
        state.source.stop(0);
      } catch (e) { /* ignore */ }
      try { state.source.disconnect(); } catch (e) { /* ignore */ }
      state.source = null;
    }
    stopTracking(true);
    state.player = null;
  }

  function measureAmplitude(analyser, sampleRate, now) {
    var data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    var startBin = Math.floor((VOCAL_LOW_HZ / (sampleRate / 2)) * data.length);
    var endBin = Math.floor((VOCAL_HIGH_HZ / (sampleRate / 2)) * data.length);
    var vocalEnergy = 0;
    for (var i = startBin; i < endBin; i += 1) {
      vocalEnergy += data[i];
    }
    var avgVol = vocalEnergy / Math.max(endBin - startBin, 1);
    if (avgVol <= NOISE_GATE) return 0;
    var baseIntensity = Math.min(1, (avgVol - NOISE_GATE) / 35);
    var modulation = 0.5 + 0.5 * Math.sin(now * 0.03);
    return Math.min(1, baseIntensity * (0.3 + 0.7 * modulation));
  }

  function trackLoop(now) {
    if (!state.playing || !state.analyser || !state.player) return;
    state.rafId = requestAnimationFrame(trackLoop);
    if (now - state.lastSendTime < MIN_INTERVAL_MS) return;
    state.lastSendTime = now;
    var amp = measureAmplitude(state.analyser, state.audioCtx.sampleRate, now);
    state.smoothAmp += (amp - state.smoothAmp) * SMOOTH_FACTOR;
    applyTalk(state.player, state.smoothAmp);
  }

  function startTracking(bufferSource, player) {
    stopTracking(false);
    state.player = player;
    var ctx = getAudioCtx();
    state.analyser = ctx.createAnalyser();
    state.analyser.fftSize = 512;
    state.analyser.smoothingTimeConstant = 0;
    bufferSource.connect(state.analyser);
    state.analyser.connect(ctx.destination);
    state.lastSendTime = 0;
    state.rafId = requestAnimationFrame(trackLoop);
  }

  function playArrayBuffer(arrayBuffer, player, onUpdate) {
    if (!arrayBuffer) return Promise.reject(new Error('缺少音频数据'));
    if (!player || !player.initialized) return Promise.reject(new Error('请先加载模型'));
    if (!hasFaceTalk(player)) return Promise.reject(new Error('当前模型无 face_talk 变量'));

    stop();
    state.onUpdate = onUpdate || null;
    state.playing = true;

    var ctx = getAudioCtx();
    return ctx
      .decodeAudioData(arrayBuffer.slice(0))
      .then(function (audioBuffer) {
        if (!state.playing) return;
        var source = ctx.createBufferSource();
        source.buffer = audioBuffer;
        state.source = source;
        startTracking(source, player);
        return new Promise(function (resolve, reject) {
          source.onended = function () {
            if (!state.playing) {
              resolve();
              return;
            }
            stop();
            resolve();
          };
          try {
            source.start(0);
          } catch (err) {
            stop();
            reject(err);
          }
        });
      })
      .catch(function (err) {
        stop();
        throw err;
      });
  }

  function playFile(file, player, onUpdate) {
    if (!file) return Promise.reject(new Error('未选择音频文件'));
    return file.arrayBuffer().then(function (raw) {
      return playArrayBuffer(raw, player, onUpdate);
    });
  }

  global.EmoteTalkSync = {
    playArrayBuffer: playArrayBuffer,
    playFile: playFile,
    stop: stop,
    isPlaying: function () { return state.playing; },
    hasFaceTalk: hasFaceTalk,
    measureAmplitude: measureAmplitude,
  };
})(window);
