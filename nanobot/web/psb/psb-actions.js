/** PSB 运行时动作解析（纯函数，便于单测）。 */
(function (global) {
  'use strict';

  function normalizeAction(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var type = String(raw.type || '').trim().toLowerCase();
    if (!type) return null;
    var payload = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
    return { type: type, payload: payload };
  }

  function pickTimelineLabel(payload, metadata) {
    var name = String(payload.name || payload.label || '').trim();
    if (!name) return { ok: false, error: 'missing timeline name' };
    var timelines = (metadata && metadata.timelines) || [];
    var match = timelines.find(function (item) {
      return item && (item.label === name || item.labelZh === name);
    });
    if (!match && timelines.length === 0) {
      return { ok: true, label: name, looping: false, unchecked: true };
    }
    if (!match) return { ok: false, error: 'unknown timeline: ' + name };
    return { ok: true, label: match.label, looping: !!match.looping };
  }

  function pickExpressionLabel(payload, metadata) {
    var name = String(payload.name || payload.label || '').trim();
    if (!name) return { ok: false, error: 'missing expression name' };
    var expressions = (metadata && metadata.expressions) || [];
    var match = expressions.find(function (item) {
      return item && (item.label === name || item.labelZh === name);
    });
    if (!match && expressions.length === 0) {
      return { ok: true, label: name, unchecked: true };
    }
    if (!match) return { ok: false, error: 'unknown expression: ' + name };
    return { ok: true, label: match.label };
  }

  function pickVariableUpdate(payload, metadata, kind) {
    var key = kind === 'face' ? 'faceVariables' : 'fadeVariables';
    var varName = String(payload.var || payload.name || '').trim();
    if (!varName) return { ok: false, error: 'missing variable name' };
    var rawValue = payload.value;
    if (rawValue === undefined || rawValue === null || rawValue === '') {
      return { ok: false, error: 'missing variable value' };
    }
    var value = Number(rawValue);
    if (Number.isNaN(value)) return { ok: false, error: 'invalid variable value' };
    var variables = (metadata && metadata[key]) || [];
    var match = variables.find(function (item) {
      return item && item.label === varName;
    });
    if (!match && variables.length === 0) {
      return { ok: true, label: varName, value: value, unchecked: true };
    }
    if (!match) return { ok: false, error: 'unknown variable: ' + varName };
    return { ok: true, label: match.label, value: value };
  }

  global.PsbActions = {
    normalizeAction: normalizeAction,
    pickTimelineLabel: pickTimelineLabel,
    pickExpressionLabel: pickExpressionLabel,
    pickFaceUpdate: function (payload, metadata) {
      return pickVariableUpdate(payload, metadata, 'face');
    },
    pickFadeUpdate: function (payload, metadata) {
      return pickVariableUpdate(payload, metadata, 'fade');
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
