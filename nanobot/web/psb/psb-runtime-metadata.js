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

  function mapVariable(variable, serverList, isFade) {
    var prev = findByLabel(serverList, variable.label);
    var hintZh = (prev && prev.hintZh) || (isFade ? fadeHintZh(variable.label) : '');
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
      hint: (prev && prev.hint) || '',
      hintZh: hintZh,
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
        diff: !!(prev && prev.diff),
        loopBegin: prev && prev.loopBegin != null ? prev.loopBegin : 0,
        loopEnd: prev && prev.loopEnd != null ? prev.loopEnd : -1,
        lastTime: prev && prev.lastTime != null ? prev.lastTime : -1,
        looping:
          typeof player.isLoopTimeline === 'function'
            ? player.isLoopTimeline(label)
            : !!(prev && prev.looping),
      };
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
        return mapVariable(variable, serverMeta.faceVariables, false);
      });

    var fadeVariables = variableList
      .filter(function (variable) {
        return isFadeVariable(variable.label);
      })
      .map(function (variable) {
        return mapVariable(variable, serverMeta.fadeVariables, true);
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

  // gateway 嵌入式 HTTP 仅支持 GET，payload 走 query；单行上限约 8KiB，大模型需分块。
  var TIMELINE_CHUNK_SIZE = 4;
  var EXPRESSION_CHUNK_SIZE = 8;
  var FACE_VARIABLE_CHUNK_SIZE = 10;
  var FADE_VARIABLE_CHUNK_SIZE = 6;
  // 预留 path + encodeURIComponent 膨胀，保守限制单块 serialized payload 体积。
  var MAX_PAYLOAD_JSON_CHARS = 2800;

  function appendListChunks(chunks, list, key, chunkSize) {
    if (!list || !list.length) return;
    for (var index = 0; index < list.length; index += chunkSize) {
      var part = {};
      part[key] = list.slice(index, index + chunkSize);
      chunks.push(part);
    }
  }

  function appendVariableChunks(chunks, list, key, chunkSize) {
    appendListChunks(chunks, list, key, chunkSize);
  }

  function estimatePayloadJsonChars(part) {
    try {
      return JSON.stringify(part).length;
    } catch (_err) {
      return MAX_PAYLOAD_JSON_CHARS + 1;
    }
  }

  function splitTimelineChunks(chunks, timelines) {
    if (!timelines || !timelines.length) return;
    var batch = [];
    timelines.forEach(function (item) {
      batch.push(item);
      var probe = { timelines: batch.slice() };
      if (
        batch.length >= TIMELINE_CHUNK_SIZE ||
        estimatePayloadJsonChars(probe) > MAX_PAYLOAD_JSON_CHARS
      ) {
        chunks.push({ timelines: batch.slice() });
        batch = [];
      }
    });
    if (batch.length) {
      chunks.push({ timelines: batch.slice() });
    }
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

  window.PsbRuntimeMetadata = {
    extract: extractRuntimeCapabilities,
    merge: mergeMetadata,
    compactForServerSync: compactForServerSync,
    splitCompactForServerSync: splitCompactForServerSync,
    fadeHintZh: fadeHintZh,
  };
})();
