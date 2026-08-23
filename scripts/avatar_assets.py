# 离线制作数字伴侣动作素材：用 ComfyUI MiniMaxH3 图生视频工作流
# 从参考图生成闭嘴待机/聆听/开心动作视频（openspec add-electron-avatar-companion tasks 5.2/5.3）
#
# 用法:
#   python scripts/avatar_assets.py submit --action idle --image D:\ref.png
#   python scripts/avatar_assets.py submit --action idle,listening,happy --image D:\ref.png
#       可选: --seed N --seconds 10 --width 1280 --height 960 --host http://127.0.0.1:8188
#   python scripts/avatar_assets.py poll <prompt_id> [超时秒, 默认1800]
#
# 动作视频约束（design.md）: 固定镜头、正脸或轻微侧脸、无遮挡、闭嘴、
# 低速运动、光照稳定、首尾一致可无缝循环。生成后需人工验收。

import json
import random
import struct
import sys
import time
import urllib.request
import uuid

# 动作池预设: 名称 -> (文件名前缀, 提示词)
# 全局约束（每条提示词须遵守）:
#   - 同一参考图生成，固定镜头半身像，首尾一致可无缝循环
#   - 固定光照与时段（防昼夜漂移），背景轻微虚化且稳定
#   - 源图本身带微笑: 不放大微笑; 表情可有自然细微变化但幅度要小
#   - 全程闭嘴（说话基底由 Wav2Lip 重绘嘴部）
_EXPRESSION = "表情以源图的浅微笑为基准自然细微变化（眼神、眉梢、嘴角轻微起伏），幅度小而平缓，不放大微笑，不张嘴"
_COLOR_LOCK = "人物服装与背景物体（沙发等）的颜色与源图完全一致，全程保持不变"

ACTIONS = {
    # 待机池
    "idle_a": (
        "avatar/idle_a",
        "固定镜头半身像，人物正对镜头，放松的待机状态。"
        "自然呼吸带来胸口和肩膀的缓慢起伏，头部偶尔缓慢地轻微偏转和倾斜，"
        "目光大部分时间看向镜头，偶尔自然移开视线再缓缓收回，每隔几秒缓慢眨眼，"
        "几缕发丝随空气轻柔飘动，身体重心偶有极轻微转移。"
        f"{_EXPRESSION}。{_COLOR_LOCK}。所有动作缓慢轻柔连续。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    "idle_b": (
        "avatar/idle_b",
        "固定镜头半身像，人物正对镜头，安静从容的待机状态。"
        "身体放松微微侧向一边，一只手轻轻抬起拂过耳边的发丝，随后手缓缓放下，"
        "头部随之轻微偏转再缓慢回正，目光低垂片刻后抬眼看向镜头，自然眨眼，呼吸平缓。"
        f"{_EXPRESSION}。{_COLOR_LOCK}。所有动作缓慢轻柔连续。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    "idle_c": (
        "avatar/idle_c",
        "固定镜头半身像，人物正对镜头，恬静的待机状态。"
        "双手轻轻交叠放回身前，肩膀随呼吸缓慢起伏，头部缓慢地微微低垂再抬回原位，"
        "目光看向侧下方片刻后回到镜头方向，再缓缓移向另一侧又收回，自然眨眼。"
        f"{_EXPRESSION}。{_COLOR_LOCK}。所有动作缓慢轻柔连续且均能回到起始姿态。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    # 说话池（中性闭合唇形，供 Wav2Lip 重绘）
    "talking_a": (
        "avatar/talking_a",
        "固定镜头半身像，人物正对镜头，面部表情平静，嘴唇全程保持自然闭合的静止状态，"
        "绝对不张嘴、不做任何说话口型动作，唇周肌肉完全放松。"
        "身体姿态自然放松，头部偶尔极缓慢地轻微偏转再回正，肩膀随呼吸轻微起伏，自然眨眼。"
        f"{_EXPRESSION}。{_COLOR_LOCK}。饰品只有极轻微自然摆动。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    "talking_b": (
        "avatar/talking_b",
        "固定镜头半身像，人物正对镜头，神态温和专注，嘴唇全程保持自然闭合的静止状态，"
        "绝对不张嘴、不做任何说话口型动作，唇周肌肉完全放松。"
        "一只手臂轻轻抬起又缓缓放下，头部随之轻微侧倾再回正，"
        "肩膀随呼吸轻微起伏，自然眨眼。"
        f"{_EXPRESSION}。{_COLOR_LOCK}。饰品只有极轻微自然摆动。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    # 工作状态池（无音频任务关联画面）
    "work_typing": (
        "avatar/work_typing",
        "固定镜头半身像，人物微微侧身面向斜前方的屏幕方向，专注工作状态。"
        "双手在胸前下方做轻柔连贯的敲键盘动作，视线落在屏幕方向，"
        "偶尔停下来微微点头，或微微侧头思考，自然眨眼。"
        f"{_EXPRESSION}。嘴唇全程闭合。{_COLOR_LOCK}。所有动作幅度小且连续。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    "work_thinking": (
        "avatar/work_thinking",
        "固定镜头半身像，人物正对镜头，沉思状态。"
        "一只手轻轻抬起托腮又缓缓放下，目光微微向上凝视片刻再回到正前方，"
        "眉毛轻微蹙起又舒展，偶尔轻轻点头像是想到了什么，自然眨眼，呼吸平缓。"
        f"{_EXPRESSION}。嘴唇全程闭合。{_COLOR_LOCK}。所有动作幅度小且连续。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    "work_organizing": (
        "avatar/work_organizing",
        "固定镜头半身像，人物正对镜头偏下方向，整理事务的状态。"
        "双手在画面下方做轻柔的翻动、整理物件的动作，视线跟随手部动作缓慢移动，"
        "偶尔抬眼看向镜头方向片刻再低下头，自然眨眼。"
        f"{_EXPRESSION}。嘴唇全程闭合。{_COLOR_LOCK}。所有动作幅度小且连续。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    # 情绪动作（可选）
    "listening": (
        "avatar/listening",
        "固定镜头半身像，人物正对镜头，专注聆听状态。"
        "身体微微前倾又回到原位，目光温和注视镜头方向，头部偶尔缓慢地轻轻点头示意，"
        "偶尔微微侧倾再回正表示在听，眉毛偶尔轻轻上扬，自然眨眼，呼吸平稳。"
        f"{_EXPRESSION}。嘴唇全程闭合。{_COLOR_LOCK}。所有动作缓慢克制。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
    "happy": (
        "avatar/happy",
        "固定镜头半身像，人物正对镜头，温柔安静愉悦的状态。"
        "眼睛微微弯起带有浅浅笑意，脸颊轻轻上抬，肩膀随轻快呼吸自然起伏，"
        "头部偶尔缓慢轻微偏转再回正，目光看向镜头带笑意，自然眨眼。"
        "微笑幅度与源图相当、不放大，不张嘴不露齿，嘴唇轻轻抿着闭合。"
        f"{_COLOR_LOCK}。所有动作缓慢轻柔连续。"
        "光照固定为白天柔和室内光，全程不变，背景轻微虚化。"
        "画面首尾姿势与神态一致，适合无缝循环。",
    ),
}

# 与 ComfyUI 工作流 "▶▷MiniMaxH3-加速视频流整合.json" 激活的图生视频组参数一致
UNET = "Minimax_H3\\minimax_h3_fl2va_pruned_int8_convrot.safetensors"
LORA = "minimax_h3\\minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors"
CLIP = "qwen3vl_32b_minimax_h3_int8_convrot.safetensors"


def upload_image(host: str, path: str) -> str:
    # multipart 上传，stdlib 实现
    boundary = uuid.uuid4().hex
    with open(path, "rb") as f:
        img = f.read()
    body = b"".join([
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="image"; filename="avatar_ref.png"\r\n',
        b"Content-Type: image/png\r\n\r\n",
        img, b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n',
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n',
        f"--{boundary}--\r\n".encode(),
    ])
    req = urllib.request.Request(f"{host}/upload/image", data=body,
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))["name"]


def frame_count(seconds: float) -> int:
    # 原工作流: max(5, round(a*24)) 向上对齐到 ≡5 (mod 17)
    n = max(5, round(seconds * 24))
    return n + (5 - n % 17) % 17


def build_prompt(img: str, text: str, prefix: str, seed: int,
                 width: int, height: int, length: int) -> dict:
    return {
        "114": {"class_type": "LoadImage", "inputs": {"image": img}},
        "121": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_video_vae_fp16.safetensors"}},
        "122": {"class_type": "VAELoader", "inputs": {"vae_name": "minimax_h3_audio_vae_fp32.safetensors"}},
        "123": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["127", 0], "vae": ["122", 0]}},
        "124": {"class_type": "VAEDecode", "inputs": {"samples": ["127", 0], "vae": ["121", 0]}},
        "125": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "126": {"class_type": "BasicScheduler",
                "inputs": {"model": ["129", 0], "scheduler": "simple", "steps": 4, "denoise": 1.0}},
        "127": {"class_type": "SamplerCustomAdvanced",
                "inputs": {"noise": ["131", 0], "guider": ["128", 0], "sampler": ["125", 0],
                           "sigmas": ["126", 0], "latent_image": ["133", 1]}},
        "128": {"class_type": "BasicGuider", "inputs": {"model": ["140", 0], "conditioning": ["133", 0]}},
        "129": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "130": {"class_type": "CLIPLoader",
                "inputs": {"clip_name": CLIP, "type": "minimax", "device": "default"}},
        "131": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "133": {"class_type": "MiniMaxH3ImageToVideo",
                "inputs": {"clip": ["130", 0], "vae": ["121", 0], "first_frame": ["340", 0],
                           "prompt": text, "width": width, "height": height, "length": length}},
        "138": {"class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch",
                "inputs": {"model": ["129", 0]}},
        "140": {"class_type": "LoraLoaderModelOnly",
                "inputs": {"model": ["138", 0], "lora_name": LORA, "strength_model": 0.75}},
        "188": {"class_type": "CreateVideo",
                "inputs": {"images": ["124", 0], "audio": ["123", 0], "fps": 24, "bit_depth": 8}},
        "189": {"class_type": "SaveVideo",
                "inputs": {"video": ["188", 0], "filename_prefix": prefix,
                           "format": "auto", "codec": "auto"}},
        "340": {"class_type": "ImageResizeKJv2",
                "inputs": {"image": ["114", 0], "width": width, "height": height,
                           "upscale_method": "lanczos", "keep_proportion": "crop",
                           "pad_color": "0, 0, 0", "crop_position": "center",
                           "divisible_by": 32, "device": "cpu"}},
    }


def cmd_submit(args):
    opts = args
    def opt(name, default=None, cast=str):
        nonlocal opts
        if f"--{name}" in opts:
            i = opts.index(f"--{name}")
            val = opts[i + 1]
            del opts[i:i + 2]
            return cast(val)
        return default

    host = opt("host", "http://127.0.0.1:8188")
    image = opt("image")
    seed = opt("seed", None, int)
    seconds = opt("seconds", 10, float)
    width = opt("width", 1280, int)
    height = opt("height", 960, int)
    actions = [a for a in opt("action", "idle").split(",") if a]
    if "all" in actions:
        actions = list(ACTIONS)
    for a in actions:
        if a not in ACTIONS:
            print(f"未知动作 {a}，可选: {', '.join(ACTIONS)}, all")
            sys.exit(1)
    if not image or opts:
        print("用法: submit --action all --image 路径 [--seed N --seconds 10 --width 1280 --height 960]")
        sys.exit(1)

    with open(image, "rb") as f:
        w, h = struct.unpack(">II", f.read(24)[16:24])
    print(f"参考图 {w}x{h}，上传到 {host}")
    server_img = upload_image(host, image)
    length = frame_count(seconds)
    print(f"帧数 {length} (~{length / 24:.1f}s)")

    for action in actions:
        prefix, text = ACTIONS[action]
        s = seed if seed is not None else random.randint(0, 2**31)
        data = json.dumps({"prompt": build_prompt(server_img, text, prefix, s, width, height, length),
                           "client_id": "nanobot-avatar-assets"}).encode("utf-8")
        req = urllib.request.Request(f"{host}/prompt", data=data,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            resp = json.loads(r.read().decode("utf-8"))
        print(f"{action}: prompt_id={resp.get('prompt_id')} seed={s}")
        if resp.get("node_errors"):
            print(json.dumps(resp["node_errors"], ensure_ascii=False)[:2000])
            sys.exit(1)


def cmd_poll(args):
    if not args:
        print("用法: poll <prompt_id> [超时秒]")
        sys.exit(1)
    prompt_id = args[0]
    host = "http://127.0.0.1:8188"
    deadline = time.time() + (int(args[1]) if len(args) > 1 else 1800)
    while time.time() < deadline:
        with urllib.request.urlopen(f"{host}/history/{prompt_id}", timeout=30) as r:
            entry = json.loads(r.read().decode("utf-8")).get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") in ("error", "success"):
                print("status:", status.get("status_str"))
                for msg in status.get("messages", []):
                    if msg[0] == "execution_error":
                        print("ERROR:", json.dumps(msg[1], ensure_ascii=False)[:1500])
                for nid, out in entry.get("outputs", {}).items():
                    for key in ("images", "gifs", "videos", "audio"):
                        for item in out.get(key, []):
                            print(f"node {nid} {key}: {item.get('subfolder', '')}/{item.get('filename', '')}")
                # 完成后释放显存（卸载模型，下次生成需冷加载）
                req = urllib.request.Request(f"{host}/free", data=b'{"unload_models": true, "free_memory": true}',
                                             headers={"Content-Type": "application/json"})
                try:
                    urllib.request.urlopen(req, timeout=30).read()
                    print("已请求 ComfyUI 卸载模型并释放显存")
                except Exception as e:  # noqa: BLE001
                    print(f"/free 失败(不影响产物): {e}")
                return
        time.sleep(10)
    print("TIMEOUT: 任务仍在队列或执行中")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python scripts/avatar_assets.py submit|poll ...")
        sys.exit(1)
    cmd = sys.argv[1]
    if cmd == "submit":
        cmd_submit(sys.argv[2:])
    elif cmd == "poll":
        cmd_poll(sys.argv[2:])
    else:
        print(f"未知子命令 {cmd}")
        sys.exit(1)
