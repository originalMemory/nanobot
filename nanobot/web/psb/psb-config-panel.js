(function () {
  'use strict';

  var MAX_FACE_VARS = 12;
  var deps = null;
  var draft = { timeline: '', expression: '', face: {}, fade: {} };
  var bound = false;

  function fadeDisplayHint(item) {
    if (!item || !item.label || !/^fade_/.test(item.label)) return '';
    if (window.PsbRuntimeMetadata && typeof window.PsbRuntimeMetadata.fadeHintZh === 'function') {
      return window.PsbRuntimeMetadata.fadeHintZh(item.label) || '';
    }
    return '';
  }

  function labelText(item) {
    if (!item) return '';
    if (typeof item === 'string') return item;
    if (item.hintZh) return item.hintZh;
    var fadeHint = fadeDisplayHint(item);
    if (fadeHint) return fadeHint;
    if (item.labelZh && item.labelZh !== item.label) return item.labelZh;
    return item.label || '';
  }

  function frameLabelText(frame) {
    if (!frame) return '';
    if (frame.labelZh && frame.labelZh !== frame.label) return frame.labelZh;
    return frame.label || String(frame.value);
  }

  function frameValueMatches(current, frameValue) {
    if (current == null || !Number.isFinite(current)) return false;
    return Math.abs(current - frameValue) < 0.001;
  }

  function emptyInitial() {
    return { timeline: '', expression: '', face: {}, fade: {} };
  }

  function cloneDraft(state) {
    var src = state || emptyInitial();
    return {
      timeline: src.timeline || '',
      expression: src.expression || '',
      face: Object.assign({}, src.face || {}),
      fade: Object.assign({}, src.fade || {}),
    };
  }

  function isLoopingTimeline(label) {
    var meta = deps && deps.getModelMetadata ? deps.getModelMetadata() : null;
    if (!label || !meta || !meta.timelines) return false;
    return meta.timelines.some(function (item) {
      return item && item.label === label && item.looping;
    });
  }

  function getPlayerVariable(label) {
    var player = deps.getPlayer ? deps.getPlayer() : null;
    if (!player || !player.initialized || !label) return null;
    return (player.variableList || []).find(function (item) {
      return item && item.label === label;
    });
  }

  function getVariableFrames(variable) {
    if (!variable) return [];
    if (variable.frames && variable.frames.length) return variable.frames;
    var live = getPlayerVariable(variable.label);
    if (live && live.frameList && live.frameList.length) return live.frameList;
    return [];
  }

  function setMessage(text, isError) {
    var el = document.getElementById('cfg-message');
    if (!el) return;
    el.textContent = text || '';
    el.className = isError ? 'cfg-message error' : 'cfg-message';
  }

  function setPanelOpen(open) {
    var panel = document.getElementById('config-panel');
    var btn = document.getElementById('config-btn');
    if (!panel) return;
    panel.classList.toggle('hidden', !open);
    if (btn) btn.classList.toggle('active', open);
    if (deps && deps.onPanelHoverChange) deps.onPanelHoverChange(!!open);
  }

  function previewDraft() {
    if (!deps) return;
    var player = deps.getPlayer();
    if (!player || !player.initialized) return;
    if (draft.timeline) {
      deps.playTimelineAction(draft.timeline, isLoopingTimeline(draft.timeline));
    }
    if (draft.expression) {
      deps.applyExpressionByName(draft.expression);
    }
    if (draft.face && Object.keys(draft.face).length) {
      deps.applyVariableMap(draft.face, undefined, undefined);
    }
    if (draft.fade && Object.keys(draft.fade).length) {
      deps.applyVariableMap(draft.fade, undefined, undefined);
    }
  }

  function applyDraftVariable(bucketKey, variableLabel, value) {
    if (!Number.isFinite(value) || Math.abs(value) <= 0.001) {
      delete draft[bucketKey][variableLabel];
    } else {
      draft[bucketKey][variableLabel] = value;
    }
    var patch = {};
    patch[variableLabel] = value;
    deps.applyVariableMap(patch, undefined, undefined);
  }

  function highlightFrameButtons(container, currentValue) {
    if (!container) return;
    Array.prototype.forEach.call(container.querySelectorAll('.cfg-frame-btn'), function (btn) {
      var frameValue = Number(btn.dataset.frameValue);
      btn.classList.toggle('active', frameValueMatches(currentValue, frameValue));
    });
  }

  function renderFrameButtons(container, variable, bucketKey) {
    if (!container) return;
    container.innerHTML = '';
    var frames = getVariableFrames(variable);
    var current = draft[bucketKey][variable.label];
    if (!frames.length) {
      var empty = document.createElement('span');
      empty.className = 'cfg-var-val';
      empty.textContent = '无可用选项';
      container.appendChild(empty);
      return;
    }
    frames.forEach(function (frame) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cfg-frame-btn';
      btn.dataset.frameValue = String(frame.value);
      btn.textContent = frameLabelText(frame);
      btn.title = variable.label + ' = ' + frame.value;
      btn.addEventListener('click', function () {
        applyDraftVariable(bucketKey, variable.label, frame.value);
        highlightFrameButtons(container, frame.value);
        if (container._slider) {
          container._slider.value = String(frame.value);
        }
      });
      container.appendChild(btn);
    });
    highlightFrameButtons(container, current);
  }

  function renderTimelineSelect() {
    var select = document.getElementById('cfg-timeline');
    var meta = deps.getModelMetadata();
    if (!select || !meta) return;
    var timelines = meta.timelines || [];
    var labels = timelines.length
      ? timelines.map(function (item) { return item.label; })
      : (deps.getPlayer() && deps.getPlayer().mainTimelineLabels) || [];
    select.innerHTML = '';
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '（无）';
    select.appendChild(empty);
    labels.forEach(function (label) {
      if (!label) return;
      var opt = document.createElement('option');
      opt.value = label;
      var item = timelines.find(function (t) { return t && t.label === label; });
      opt.textContent = item ? labelText(item) : label;
      if (!item || !item.looping) {
        opt.textContent += ' · 非循环';
      }
      select.appendChild(opt);
    });
    select.value = draft.timeline || '';
  }

  function renderExpressionSelect() {
    var select = document.getElementById('cfg-expression');
    var meta = deps.getModelMetadata();
    if (!select || !meta) return;
    select.innerHTML = '';
    var empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '（无）';
    select.appendChild(empty);
    (meta.expressions || []).forEach(function (item) {
      var opt = document.createElement('option');
      opt.value = item.label;
      opt.textContent = labelText(item);
      select.appendChild(opt);
    });
    select.value = draft.expression || '';
  }

  function renderFaceSelectOptions(faceVars) {
    var select = document.getElementById('cfg-face-select');
    if (!select) return;
    var selected = select.value;
    select.innerHTML = '';
    if (!faceVars.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = '（无）';
      select.appendChild(empty);
      return;
    }
    faceVars.forEach(function (variable) {
      var opt = document.createElement('option');
      opt.value = variable.label;
      opt.textContent = labelText(variable);
      select.appendChild(opt);
    });
    if (!selected || !faceVars.some(function (item) { return item.label === selected; })) {
      selected = faceVars[0].label;
    }
    select.value = selected;
  }

  function renderFaceFramesForSelection(faceVars) {
    var select = document.getElementById('cfg-face-select');
    var framesContainer = document.getElementById('cfg-face-frames');
    if (!select || !framesContainer) return;
    if (!faceVars.length) {
      framesContainer.innerHTML = '';
      return;
    }
    var active = faceVars.find(function (item) { return item.label === select.value; }) || faceVars[0];
    if (active && active.label !== select.value) {
      select.value = active.label;
    }
    renderFrameButtons(framesContainer, active, 'face');
  }

  function renderFaceControls() {
    var meta = deps.getModelMetadata();
    if (!meta) return;
    var faceVars = (meta.faceVariables || []).slice(0, MAX_FACE_VARS);
    renderFaceSelectOptions(faceVars);
    renderFaceFramesForSelection(faceVars);
  }

  function buildFadeVariableRow(variable) {
    var row = document.createElement('div');
    row.className = 'cfg-fade-row';
    var label = document.createElement('label');
    label.textContent = labelText(variable);
    row.appendChild(label);

    var frameGroup = document.createElement('div');
    frameGroup.className = 'cfg-frame-group';
    renderFrameButtons(frameGroup, variable, 'fade');
    row.appendChild(frameGroup);

    var frames = getVariableFrames(variable);
    var min = variable.minValue != null ? variable.minValue : 0;
    var max = variable.maxValue != null ? variable.maxValue : 1;
    if (frames.length && max - min <= 1.001 && max > min) {
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(min);
      slider.max = String(max);
      slider.step = '0.05';
      var current = draft.fade[variable.label];
      slider.value = String(current != null ? current : min);
      slider.title = variable.label + ' 混合';
      slider.addEventListener('input', function () {
        var next = parseFloat(slider.value);
        if (!Number.isFinite(next)) return;
        applyDraftVariable('fade', variable.label, next);
        highlightFrameButtons(frameGroup, next);
      });
      frameGroup._slider = slider;
      row.appendChild(slider);
    }
    return row;
  }

  function renderFadeList() {
    var container = document.getElementById('cfg-fade-list');
    var meta = deps.getModelMetadata();
    if (!container || !meta) return;
    container.innerHTML = '';
    (meta.fadeVariables || []).forEach(function (variable) {
      if (!variable || !variable.label) return;
      container.appendChild(buildFadeVariableRow(variable));
    });
  }

  function renderForm() {
    if (!deps) return;
    var meta = deps.getModelMetadata();
    if (!meta) return;
    renderTimelineSelect();
    renderExpressionSelect();
    renderFaceControls();
    renderFadeList();
    updateSaveState();
  }

  function updateSaveState() {
    var saveBtn = document.getElementById('cfg-save-btn');
    if (!saveBtn) return;
    var ok = !draft.timeline || isLoopingTimeline(draft.timeline);
    saveBtn.disabled = !ok;
    if (!ok && draft.timeline) {
      setMessage('初始 timeline 须选择循环项', true);
    } else {
      setMessage('');
    }
  }

  function loadDraftFromSaved() {
    var saved = deps.getSavedInitialState ? deps.getSavedInitialState() : null;
    draft = cloneDraft(saved || emptyInitial());
    renderForm();
  }

  function captureFromPlayer() {
    var player = deps.getPlayer();
    var meta = deps.getModelMetadata();
    if (!player || !player.initialized || !meta) return;
    draft.timeline = player.mainTimelineLabel || draft.timeline || '';
    (meta.faceVariables || []).slice(0, MAX_FACE_VARS).forEach(function (variable) {
      if (!variable || !variable.label) return;
      var val = player.getVariable(variable.label);
      if (Number.isFinite(val) && Math.abs(val) > 0.001) {
        draft.face[variable.label] = val;
      } else {
        delete draft.face[variable.label];
      }
    });
    (meta.fadeVariables || []).forEach(function (variable) {
      if (!variable || !variable.label) return;
      var val = player.getVariable(variable.label);
      if (Number.isFinite(val) && Math.abs(val) > 0.001) {
        draft.fade[variable.label] = val;
      } else {
        delete draft.fade[variable.label];
      }
    });
    renderForm();
    previewDraft();
    setMessage('已读取当前展示状态');
  }

  function saveInitialState() {
    if (!deps || !deps.getModelId()) return;
    if (draft.timeline && !isLoopingTimeline(draft.timeline)) {
      setMessage('初始 timeline 须选择循环项', true);
      return;
    }
    var modelId = deps.getModelId();
    var query = new URLSearchParams();
    query.set('state', JSON.stringify({
      timeline: draft.timeline || '',
      expression: draft.expression || '',
      face: draft.face || {},
      fade: draft.fade || {},
    }));
    var path =
      '/api/desk-pet/psb/models/' +
      encodeURIComponent(modelId) +
      '/initial-state/update?' +
      query.toString();
    setMessage('正在保存…');
    deps
      .fetchJson(path)
      .then(function (payload) {
        var model = payload && payload.model;
        var next = (model && model.initialState) || cloneDraft(draft);
        if (deps.setSavedInitialState) deps.setSavedInitialState(next);
        if (deps.setModelMetadata && model) deps.setModelMetadata(model);
        draft = cloneDraft(next);
        renderForm();
        setMessage('已保存初始状态');
      })
      .catch(function (err) {
        setMessage((err && err.message) || '保存失败', true);
      });
  }

  function bindOnce() {
    if (bound) return;
    bound = true;

    var configBtn = document.getElementById('config-btn');
    var closeBtn = document.getElementById('cfg-close-btn');
    var captureBtn = document.getElementById('cfg-capture-btn');
    var saveBtn = document.getElementById('cfg-save-btn');
    var timelineSelect = document.getElementById('cfg-timeline');
    var expressionSelect = document.getElementById('cfg-expression');
    var faceSelect = document.getElementById('cfg-face-select');
    var panel = document.getElementById('config-panel');

    if (configBtn) {
      configBtn.addEventListener('click', function () {
        var open = panel && panel.classList.contains('hidden');
        if (open) {
          var ready = deps.ensureModelMetadataReady
            ? deps.ensureModelMetadataReady()
            : Promise.resolve();
          ready
            .then(function () {
              loadDraftFromSaved();
              setPanelOpen(true);
            })
            .catch(function () {
              loadDraftFromSaved();
              setPanelOpen(true);
            });
        } else {
          setPanelOpen(false);
        }
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener('click', function () {
        setPanelOpen(false);
      });
    }

    if (captureBtn) {
      captureBtn.addEventListener('click', captureFromPlayer);
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', saveInitialState);
    }

    if (timelineSelect) {
      timelineSelect.addEventListener('change', function () {
        draft.timeline = timelineSelect.value || '';
        updateSaveState();
        if (draft.timeline) {
          deps.playTimelineAction(draft.timeline, isLoopingTimeline(draft.timeline));
        }
      });
    }

    if (expressionSelect) {
      expressionSelect.addEventListener('change', function () {
        draft.expression = expressionSelect.value || '';
        if (draft.expression) deps.applyExpressionByName(draft.expression);
      });
    }

    if (faceSelect) {
      faceSelect.addEventListener('change', function () {
        var meta = deps.getModelMetadata();
        if (!meta) return;
        renderFaceFramesForSelection((meta.faceVariables || []).slice(0, MAX_FACE_VARS));
      });
    }

    if (panel) {
      panel.addEventListener('mouseenter', function () {
        panel.dataset.hovered = '1';
        if (deps.onPanelHoverChange) deps.onPanelHoverChange(true);
      });
      panel.addEventListener('mouseleave', function () {
        delete panel.dataset.hovered;
        if (deps.onPanelHoverChange) deps.onPanelHoverChange(false);
      });
    }
  }

  window.PsbConfigPanel = {
    init: function (options) {
      deps = options;
      bindOnce();
    },
    refresh: function () {
      if (!deps) return;
      var saved = deps.getSavedInitialState ? deps.getSavedInitialState() : null;
      draft = cloneDraft(saved || emptyInitial());
      renderForm();
    },
    isOpen: function () {
      var panel = document.getElementById('config-panel');
      return !!(panel && !panel.classList.contains('hidden'));
    },
    isHovered: function () {
      var panel = document.getElementById('config-panel');
      return !!(panel && panel.dataset.hovered === '1');
    },
    close: function () {
      setPanelOpen(false);
    },
  };
})();
