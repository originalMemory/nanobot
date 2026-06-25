(function () {
  'use strict';

  var FACE_VAR_PATTERN = /^face_|^arm_type$/;
  var FADE_VAR_PATTERN = /^fade_/;
  var EXPRESSION_PRESET_NAMES = ['通常', '怒', '笑', 'びっくり'];
  // E-mote 标准 fade 槽位 UI 说明。PSB 运行时 SDK 只有 fade_w 等机器名与「表示/非表示」帧；
  // 日文含义仅见于 FreeMote 反编译 JSON 的图层 metadata（如 stchit01vll），故前端用固定中文展示。
  var FADE_PART_HINTS = {
    fade_w: '鼓脸（鼓起脸颊）',
    fade_x: '焦急·大害羞',
    fade_y: '脸颊5',
    fade_v: '白眼呆愣·遮鼻',
    fade_z: '面部阴影',
  };
  var IDLE_LOOP_TIMELINE_LABELS = { '待機': true, 'おさんぽ': true };

  function isFaceVariable(label) {
    return FACE_VAR_PATTERN.test(label);
  }

  function isFadeVariable(label) {
    return FADE_VAR_PATTERN.test(label);
  }

  function findByLabel(list, label) {
    if (!list || !label) return null;
    return list.find(function (item) {
      return item && item.label === label;
    }) || null;
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

  function collectExpressionPresets(variableList) {
    var faceVars = (variableList || []).filter(function (v) {
      return isFaceVariable(v.label);
    });
    var presets = [];
    EXPRESSION_PRESET_NAMES.forEach(function (name) {
      var values = {};
      var matched = 0;
      faceVars.forEach(function (variable) {
        var frame = findFrameByPresetName(variable.frameList, name);
        if (frame) {
          values[variable.label] = frame.value;
          matched += 1;
        }
      });
      if (matched > 0) presets.push({ name: name, values: values });
    });
    return presets;
  }

  function fadeHintZh(label) {
    return FADE_PART_HINTS[label] || '';
  }

  function touchDiffTimelineLabels(player) {
    if (player && typeof player.touchDiffTimelineLabels === 'function') {
      player.touchDiffTimelineLabels();
    }
  }

  function isDiffTimelineLabel(player, label) {
    touchDiffTimelineLabels(player);
    var diffLabels = (player && player.diffTimelineLabels) || [];
    return diffLabels.indexOf(label) >= 0;
  }

  /** 桌宠运行时只依赖 looping；loopBegin/loopEnd 为 sidecar 占位，不参与判定。 */
  function resolveTimelineLooping(player, label, prev) {
    if (isDiffTimelineLabel(player, label)) {
      return false;
    }
    if (IDLE_LOOP_TIMELINE_LABELS[label]) {
      return true;
    }
    if (prev && typeof prev.looping === 'boolean') {
      return prev.looping;
    }
    if (typeof player.isLoopTimeline === 'function' && !player.isLoopTimeline(label)) {
      return false;
    }
    return false;
  }

  function mapVariable(variable, serverList) {
    var prev = findByLabel(serverList, variable.label);
    var frames = (variable.frameList || []).map(function (frame) {
      var prevFrame = prev && prev.frames
        ? prev.frames.find(function (item) {
            return item && item.label === frame.label;
          })
        : null;
      return {
        label: frame.label,
        labelZh: (prevFrame && prevFrame.labelZh) || (prev && prev.labelZh) || frame.label,
        value: frame.value,
      };
    });
    return {
      label: variable.label,
      labelZh: (prev && prev.labelZh) || variable.label,
      minValue: variable.minValue,
      maxValue: variable.maxValue,
      frames: frames,
    };
  }

  function extractRuntimeCapabilities(player, serverMeta) {
    serverMeta = serverMeta || {};
    if (!player || !player.initialized) {
      return {
        timelines: serverMeta.timelines || [],
        expressions: serverMeta.expressions || [],
        faceVariables: serverMeta.faceVariables || [],
        fadeVariables: serverMeta.fadeVariables || [],
        hasFaceTalk: !!serverMeta.hasFaceTalk,
      };
    }

    if (typeof player.touchVariableList === 'function') player.touchVariableList();
    if (typeof player.touchMainTimelineLabels === 'function') player.touchMainTimelineLabels();

    var timelines = (player.mainTimelineLabels || []).map(function (label) {
      var prev = findByLabel(serverMeta.timelines, label);
      return {
        label: label,
        labelZh: (prev && prev.labelZh) || label,
        looping: resolveTimelineLooping(player, label, prev),
      };
    });

    touchDiffTimelineLabels(player);
    var seenTimelineLabels = {};
    timelines.forEach(function (item) {
      if (item && item.label) seenTimelineLabels[item.label] = true;
    });
    ((player.diffTimelineLabels || [])).forEach(function (label) {
      if (!label || seenTimelineLabels[label]) return;
      var prev = findByLabel(serverMeta.timelines, label);
      timelines.push({
        label: label,
        labelZh: (prev && prev.labelZh) || label,
        looping: false,
      });
      seenTimelineLabels[label] = true;
    });

    var variableList = player.variableList || [];
    var presets = collectExpressionPresets(variableList);
    var expressions = presets.map(function (preset) {
      var prev = findByLabel(serverMeta.expressions, preset.name);
      return {
        label: preset.name,
        labelZh: (prev && prev.labelZh) || preset.name,
      };
    });

    var faceVariables = variableList
      .filter(function (variable) {
        return isFaceVariable(variable.label);
      })
      .map(function (variable) {
        return mapVariable(variable, serverMeta.faceVariables);
      });

    var fadeVariables = variableList
      .filter(function (variable) {
        return isFadeVariable(variable.label);
      })
      .map(function (variable) {
        return mapVariable(variable, serverMeta.fadeVariables);
      });

    var hasFaceTalk = variableList.some(function (variable) {
      return variable.label === 'face_talk';
    });

    return {
      timelines: timelines,
      expressions: expressions,
      faceVariables: faceVariables,
      fadeVariables: fadeVariables,
      hasFaceTalk: hasFaceTalk,
    };
  }

  function mergeMetadata(serverMeta, runtimeCaps) {
    var base = serverMeta || {};
    var runtime = runtimeCaps || {};
    return Object.assign({}, base, {
      timelines: runtime.timelines || base.timelines || [],
      expressions: runtime.expressions || base.expressions || [],
      faceVariables: runtime.faceVariables || base.faceVariables || [],
      fadeVariables: runtime.fadeVariables || base.fadeVariables || [],
      hasFaceTalk:
        runtime.hasFaceTalk != null ? runtime.hasFaceTalk : base.hasFaceTalk,
    });
  }

  function compactForServerSync(runtimeCaps) {
    return {
      timelines: (runtimeCaps.timelines || []).map(function (item) {
        return { label: item.label, looping: item.looping };
      }),
      expressions: (runtimeCaps.expressions || []).map(function (item) {
        return { label: item.label };
      }),
      faceVariables: (runtimeCaps.faceVariables || []).map(function (item) {
        return {
          label: item.label,
          minValue: item.minValue,
          maxValue: item.maxValue,
          frames: (item.frames || []).map(function (frame) {
            return { label: frame.label, value: frame.value };
          }),
        };
      }),
      fadeVariables: (runtimeCaps.fadeVariables || []).map(function (item) {
        return {
          label: item.label,
          minValue: item.minValue,
          maxValue: item.maxValue,
          frames: (item.frames || []).map(function (frame) {
            return { label: frame.label, value: frame.value };
          }),
        };
      }),
      hasFaceTalk: runtimeCaps.hasFaceTalk,
    };
  }

  // gateway 嵌入式 HTTP 仅支持 GET，payload 走 query；请求行默认上限 8KiB（可经环境变量调高）。
  var MAX_REQUEST_LINE_CHARS = 7500;
  // path + modelId + ?payload= 的保守估计（与 psb.js runtimeMetadataUpdatePath 对齐）。
  var RUNTIME_UPDATE_PATH_PREFIX_CHARS = 128;
  var TIMELINE_CHUNK_SIZE = 4;
  var EXPRESSION_CHUNK_SIZE = 8;
  var FACE_VARIABLE_CHUNK_SIZE = 10;
  var FADE_VARIABLE_CHUNK_SIZE = 6;

  function estimateRuntimeSyncRequestLineChars(part) {
    try {
      var encoded = 'payload=' + encodeURIComponent(JSON.stringify(part));
      return RUNTIME_UPDATE_PATH_PREFIX_CHARS + encoded.length;
    } catch (_err) {
      return MAX_REQUEST_LINE_CHARS + 1;
    }
  }

  function appendListChunks(chunks, list, key, chunkSize) {
    if (!list || !list.length) return;
    var batch = [];
    for (var index = 0; index < list.length; index += 1) {
      batch.push(list[index]);
      var probe = {};
      probe[key] = batch.slice();
      var tooLong = estimateRuntimeSyncRequestLineChars(probe) > MAX_REQUEST_LINE_CHARS;
      if (tooLong) {
        if (batch.length === 1) {
          chunks.push(probe);
          batch = [];
          continue;
        }
        var overflow = batch.pop();
        var part = {};
        part[key] = batch.slice();
        chunks.push(part);
        batch = [overflow];
        index -= 1;
        continue;
      }
      if (batch.length >= chunkSize) {
        var full = {};
        full[key] = batch.slice();
        chunks.push(full);
        batch = [];
      }
    }
    if (batch.length) {
      var tail = {};
      tail[key] = batch.slice();
      chunks.push(tail);
    }
  }

  function appendVariableChunks(chunks, list, key, chunkSize) {
    appendListChunks(chunks, list, key, chunkSize);
  }

  function splitTimelineChunks(chunks, timelines) {
    appendListChunks(chunks, timelines, 'timelines', TIMELINE_CHUNK_SIZE);
  }

  function splitCompactForServerSync(compact) {
    compact = compact || {};
    var chunks = [];
    splitTimelineChunks(chunks, compact.timelines);
    appendListChunks(chunks, compact.expressions, 'expressions', EXPRESSION_CHUNK_SIZE);
    if (compact.hasFaceTalk != null) {
      chunks.push({ hasFaceTalk: compact.hasFaceTalk });
    }
    appendVariableChunks(chunks, compact.faceVariables, 'faceVariables', FACE_VARIABLE_CHUNK_SIZE);
    appendVariableChunks(chunks, compact.fadeVariables, 'fadeVariables', FADE_VARIABLE_CHUNK_SIZE);
    return chunks;
  }

  function collectLabels(list) {
    var labels = [];
    (list || []).forEach(function (item) {
      if (item && item.label) labels.push(item.label);
    });
    return labels;
  }

  function labelsAreCovered(serverList, runtimeList) {
    var serverLabels = {};
    collectLabels(serverList).forEach(function (label) {
      serverLabels[label] = true;
    });
    var runtimeLabels = collectLabels(runtimeList);
    if (!runtimeLabels.length) return true;
    for (var i = 0; i < runtimeLabels.length; i++) {
      if (!serverLabels[runtimeLabels[i]]) return false;
    }
    return true;
  }

  /** 服务端 sidecar 已包含本次运行时 label 时跳过上报；字段纠错请删 .meta.json 后重开桌宠。 */
  function needsServerSync(serverMeta, compact) {
    serverMeta = serverMeta || {};
    compact = compact || {};
    var serverTimelines = serverMeta.timelines || [];
    if (!serverTimelines.length) return true;
    if (!labelsAreCovered(serverTimelines, compact.timelines)) return true;
    if (!labelsAreCovered(serverMeta.expressions, compact.expressions)) return true;
    if (!labelsAreCovered(serverMeta.faceVariables, compact.faceVariables)) return true;
    if (!labelsAreCovered(serverMeta.fadeVariables, compact.fadeVariables)) return true;
    return false;
  }

  window.PsbRuntimeMetadata = {
    extract: extractRuntimeCapabilities,
    merge: mergeMetadata,
    compactForServerSync: compactForServerSync,
    splitCompactForServerSync: splitCompactForServerSync,
    needsServerSync: needsServerSync,
    resolveTimelineLooping: resolveTimelineLooping,
    estimateRuntimeSyncRequestLineChars: estimateRuntimeSyncRequestLineChars,
    fadeHintZh: fadeHintZh,
  };
})();
