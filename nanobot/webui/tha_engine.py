"""THA 桌面宠物模型管理与渲染引擎。"""

from __future__ import annotations

import math
import sys
import time
from pathlib import Path
from typing import Any

from nanobot.config.paths import get_tha_model_dir

DEFAULT_THA_MODELS_DIR = Path(__file__).resolve().parents[1] / "web" / "tha_models"
FIXED_MODEL_ID = "default"


def _coremltools_available() -> bool:
    try:
        import coremltools  # noqa: F401
    except ImportError:
        return False
    return True


def _linear_to_srgb(x: Any) -> Any:
    import numpy as np

    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * (x ** (1.0 / 2.4)) - 0.055)

EMOTION_POSE_MAP: dict[str, dict[int, float]] = {
    "happy": {8: 1.0, 9: 1.0, 14: 1.0, 15: 1.0, 34: 1.0, 35: 1.0},
    "sad": {0: 0.8, 1: 0.8, 6: 0.8, 7: 0.8, 32: 0.8, 33: 0.8},
    "angry": {2: 0.9, 3: 0.9, 4: 0.9, 5: 0.9, 20: 0.9, 21: 0.9},
    "surprised": {6: 0.7, 7: 0.7, 16: 0.7, 17: 0.7, 26: 0.7, 30: 0.7},
    "relaxed": {18: 1.0, 19: 1.0},
    "neutral": {},
}

THA_MOTIONS: dict[str, dict[str, Any]] = {
    "nod": {"params": {39: 0.55}, "type": "oscillate", "duration": 1.4, "frequency": 2.8},
    "shakeHead": {"params": {40: 0.5}, "type": "oscillate", "duration": 1.0, "frequency": 3.5},
    "tiltHead": {"params": {41: 0.55}, "type": "oscillate", "duration": 1.2, "frequency": 2.2},
    "bow": {"params": {43: 0.6}, "type": "hold", "duration": 1.5},
    "sway": {"params": {42: 0.45}, "type": "oscillate", "duration": 1.5, "frequency": 2.0},
    "lookAround": {
        "params": {38: 0.7, 37: 0.4},
        "type": "oscillate",
        "duration": 2.0,
        "frequency": 1.5,
    },
}


def _pose_from_map(values: dict[int, float]) -> list[float]:
    pose = [0.0] * 45
    for idx, value in values.items():
        pose[idx] = value
    return pose


class THAPoseGenerator:
    """生成 THA 45 维 pose，混合空闲动画、表情、动作和口型。"""

    def __init__(self) -> None:
        self.t = 0.0
        self.last = time.perf_counter()
        self._emotion_pose = [0.0] * 45
        self._emotion_target = [0.0] * 45
        self._mouth_amplitude = 0.0
        self._mouth_target = 0.0
        self._mouse_x = 0.0
        self._mouse_y = 0.0
        self.mx = 0.0
        self.my = 0.0
        self._motion_name: str | None = None
        self._motion_timer = 0.0
        self._motion_data: dict[str, Any] = {}
        self._blink_timer = 0.0
        self._next_blink = 2.5

    def set_emotion(self, emotion_name: str) -> None:
        self._emotion_target = _pose_from_map(
            EMOTION_POSE_MAP.get(emotion_name, EMOTION_POSE_MAP["neutral"])
        )

    def set_mouth(self, amplitude: float) -> None:
        self._mouth_target = max(0.0, min(1.0, float(amplitude)))

    def set_mouse(self, x: float, y: float) -> None:
        self._mouse_x = float(x)
        self._mouse_y = float(y)

    def set_motion(self, motion_name: str) -> None:
        if motion_name in THA_MOTIONS:
            self._motion_name = motion_name
            self._motion_timer = 0.0
            self._motion_data = THA_MOTIONS[motion_name]

    def clear_motion(self) -> None:
        self._motion_name = None
        self._motion_data = {}

    def step(self) -> list[float]:
        now = time.perf_counter()
        dt = min(max(now - self.last, 0.0), 0.2)
        self.last = now
        self.t += dt

        for idx in range(45):
            self._emotion_pose[idx] += (
                self._emotion_target[idx] - self._emotion_pose[idx]
            ) * min(dt * 4.0, 1.0)
        self._mouth_amplitude += (self._mouth_target - self._mouth_amplitude) * min(
            dt * 120.0,
            1.0,
        )
        self.mx += (self._mouse_x - self.mx) * min(dt * 8.0, 1.0)
        self.my += (self._mouse_y - self.my) * min(dt * 8.0, 1.0)

        pose = [0.0] * 45
        pose[44] = 0.8 * abs(math.sin(self.t * 0.9))
        pose[39] = 0.25 * math.sin(self.t * 1.1) - self.my * 1.1
        pose[40] = 0.18 * math.sin(self.t * 1.3) - self.mx * 0.9
        pose[41] = 0.12 * math.sin(self.t * 0.55)
        pose[42] = -self.mx * 0.75
        pose[37] = 0.12 * math.sin(self.t * 0.45) - self.my * 0.85
        pose[38] = 0.10 * math.sin(self.t * 0.55) - self.mx * 0.95

        self._blink_timer += dt
        if self._blink_timer >= self._next_blink:
            progress = min((self._blink_timer - self._next_blink) / 0.18, 1.0)
            blink = math.sin(progress * math.pi)
            pose[18] = max(pose[18], blink)
            pose[19] = max(pose[19], blink)
            if progress >= 1.0:
                self._blink_timer = 0.0
                self._next_blink = 2.0 + (time.perf_counter() % 3.0)

        for idx, value in enumerate(self._emotion_pose):
            pose[idx] += value
        pose[26] += self._mouth_amplitude

        if self._motion_name:
            self._motion_timer += dt
            duration = float(self._motion_data.get("duration", 1.5))
            progress = min(self._motion_timer / duration, 1.0)
            if self._motion_data.get("type") == "hold":
                if progress < 0.2:
                    motion_value = progress / 0.2
                elif progress < 0.7:
                    motion_value = 1.0
                else:
                    motion_value = max(0.0, 1.0 - (progress - 0.7) / 0.3)
            else:
                frequency = float(self._motion_data.get("frequency", 2.0))
                motion_value = math.sin(progress * math.pi) * math.sin(
                    self._motion_timer * frequency * 2.0 * math.pi
                )
            for idx, scale in self._motion_data.get("params", {}).items():
                pose[int(idx)] += motion_value * float(scale)
            if progress >= 1.0:
                self.clear_motion()

        return pose


class THAEngine:
    """ONNX Runtime 渲染引擎。"""

    def __init__(self, model_path: Path) -> None:
        self.model_path = model_path
        self.session: Any = None
        self.loaded = False
        self._out_is_uint8: bool | None = None
        self._out_range_neg: bool | None = None
        self._inv255 = 1.0 / 255.0
        import numpy as np

        self.green_bg = np.array([0.0, 255.0, 0.0], dtype=np.float32).reshape(3, 1, 1)

    def load(self) -> None:
        if self.loaded:
            return
        try:
            import onnxruntime as ort
        except ImportError as exc:
            raise RuntimeError("THA ONNX 渲染需要安装 onnxruntime") from exc

        provider_options: list[tuple[str, dict[str, Any]]] = [
            ("TensorrtExecutionProvider", {"trt_fp16_enable": True}),
            ("CUDAExecutionProvider", {"gpu_mem_limit": 2 * 1024 * 1024 * 1024}),
            ("ROCMExecutionProvider", {"gpu_mem_limit": 2 * 1024 * 1024 * 1024}),
            ("DmlExecutionProvider", {}),
            ("CoreMLExecutionProvider", {}),
            ("CPUExecutionProvider", {}),
        ]
        available = set(ort.get_available_providers())
        providers = [
            (name, options) if options else name
            for name, options in provider_options
            if name in available
        ] or ["CPUExecutionProvider"]

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(str(self.model_path), options, providers=providers)
        self.loaded = True

    def render(self, pose: list[float]) -> bytes:
        if not self.loaded:
            self.load()
        try:
            import numpy as np
            import simplejpeg
        except ImportError as exc:
            raise RuntimeError("THA 渲染需要安装 numpy 和 simplejpeg") from exc

        output = self.session.run(None, {"pose": np.asarray(pose, dtype=np.float32).reshape(1, 45)})[0]
        image = output[0]
        channels = image.shape[0]
        _clip = np.clip

        if channels == 4:
            rgb = image[:3]
            alpha = image[3]
            if self._out_is_uint8 is None:
                self._out_is_uint8 = image.dtype == np.uint8
                if not self._out_is_uint8:
                    self._out_range_neg = bool(np.min(rgb) < -0.1)

            if self._out_is_uint8:
                alpha_f = alpha.astype(np.float32)[np.newaxis, :, :] * self._inv255
                result = rgb.astype(np.float32) * alpha_f + self.green_bg * (1.0 - alpha_f)
                result = _clip(result, 0, 255).astype(np.uint8)
            else:
                if self._out_range_neg:
                    rgb = (rgb + 1.0) * 127.5
                    alpha = (alpha + 1.0) * 0.5
                else:
                    rgb = rgb * 255.0
                alpha_f = alpha[np.newaxis, :, :]
                result = rgb * alpha_f + self.green_bg * (1.0 - alpha_f)
                result = _clip(result, 0, 255).astype(np.uint8)
        elif channels == 3:
            if self._out_is_uint8 is None:
                self._out_is_uint8 = image.dtype == np.uint8
                if not self._out_is_uint8:
                    self._out_range_neg = bool(np.min(image) < -0.1)

            if self._out_is_uint8:
                result = image
            elif self._out_range_neg:
                result = _clip((image + 1.0) * 127.5, 0, 255).astype(np.uint8)
            else:
                result = _clip(image * 255.0, 0, 255).astype(np.uint8)
        else:
            raise RuntimeError(f"不支持的 THA 输出通道数: {channels}")
        rgb = np.ascontiguousarray(result.transpose(1, 2, 0))
        return simplejpeg.encode_jpeg(rgb, quality=50, colorspace="RGB", colorsubsampling="422")


class CoreMLTHAEngine:
    """CoreML .mlpackage 渲染引擎。"""

    def __init__(self, model_path: Path) -> None:
        self.model_path = model_path
        self.model: Any = None
        self.output_key: str | None = None
        self.loaded = False
        import numpy as np

        self.green_bg = np.array([0.0, 255.0, 0.0], dtype=np.float32).reshape(3, 1, 1)

    def load(self) -> None:
        if self.loaded:
            return
        try:
            from coremltools.models import MLModel
        except ImportError as exc:
            raise RuntimeError("THA CoreML 渲染需要安装 coremltools") from exc
        self.model = MLModel(str(self.model_path))
        outputs = [item.name for item in self.model.get_spec().description.output]
        self.output_key = next((name for name in outputs if name != "pose"), None)
        self.loaded = True

    def render(self, pose: list[float]) -> bytes:
        if not self.loaded:
            self.load()
        try:
            import numpy as np
            import simplejpeg
        except ImportError as exc:
            raise RuntimeError("THA 渲染需要安装 numpy 和 simplejpeg") from exc
        result = self.model.predict({"pose": np.asarray(pose, dtype=np.float32).reshape(1, 45)})
        image = result[self.output_key] if self.output_key else next(iter(result.values()))
        image = image[0]
        channels = image.shape[0]
        _clip = np.clip

        if channels == 4:
            rgb = image[:3, :, :]
            alpha = image[3, :, :]
            rgb = (rgb + 1.0) * 0.5
            alpha = (alpha + 1.0) * 0.5
            safe_a = np.where(alpha > 1e-6, alpha, 1.0)
            rgb = rgb / safe_a[np.newaxis, :, :]
            rgb = _linear_to_srgb(_clip(rgb, 0, 1))
            alpha_a = alpha[np.newaxis, :, :]
            output = rgb * 255.0 * alpha_a + self.green_bg * (1.0 - alpha_a)
            output = _clip(output, 0, 255).astype(np.uint8)
        elif channels == 3:
            output = image if image.dtype == np.uint8 else _clip((image + 1.0) * 127.5, 0, 255).astype(
                np.uint8
            )
        else:
            raise RuntimeError(f"不支持的 THA 输出通道数: {channels}")
        rgb = np.ascontiguousarray(output.transpose(1, 2, 0))
        return simplejpeg.encode_jpeg(rgb, quality=50, colorspace="RGB", colorsubsampling="422")


class THAModelManager:
    """定位固定 THA 模型文件。"""

    def __init__(
        self,
        default_dir: Path | None = None,
        model_dir: Path | None = None,
    ) -> None:
        self.default_dir = default_dir or DEFAULT_THA_MODELS_DIR
        self.model_dir = model_dir or get_tha_model_dir()

    def model_path(self) -> Path | None:
        self.model_dir.mkdir(parents=True, exist_ok=True)
        for root in (self.model_dir, self.default_dir):
            found = self._find_model_path(root)
            if found is not None:
                return found
        return None

    def model_payload(self) -> dict[str, str | bool]:
        model_path = self.model_path()
        if model_path is None:
            return {
                "id": FIXED_MODEL_ID,
                "name": "THA",
                "available": False,
                "format": "",
                "path": str(self.model_dir / "model.onnx"),
            }
        return {
            "id": FIXED_MODEL_ID,
            "name": "THA",
            "available": True,
            "format": "mlpackage" if model_path.suffix == ".mlpackage" else "onnx",
            "path": str(model_path),
        }

    def _find_model_path(self, root: Path) -> Path | None:
        onnx = root / "model.onnx"
        mlpackage = root / "model.mlpackage"
        if sys.platform == "darwin" and mlpackage.is_dir() and _coremltools_available():
            return mlpackage
        if onnx.is_file():
            return onnx
        if sys.platform == "darwin" and mlpackage.is_dir():
            return mlpackage
        return None


_ENGINE_CACHE: dict[Path, THAEngine | CoreMLTHAEngine] = {}


def get_engine(model_path: Path) -> THAEngine | CoreMLTHAEngine:
    model_path = model_path.resolve(strict=False)
    if model_path not in _ENGINE_CACHE:
        if model_path.suffix == ".mlpackage" or model_path.is_dir():
            _ENGINE_CACHE[model_path] = CoreMLTHAEngine(model_path)
        else:
            _ENGINE_CACHE[model_path] = THAEngine(model_path)
    return _ENGINE_CACHE[model_path]


def clear_engine_cache() -> None:
    _ENGINE_CACHE.clear()
