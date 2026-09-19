# lover-next 在现有 NAS 上升级

现有目录为 `/mnt/cache/appdata/nanobot`（Windows 映射 `V:\nanobot`）。
使用根目录的 **独立配置** `docker-compose.unraid.yml`，不要叠加旧 `docker-compose.yml`。
本次只准备部署文件，尚未切换 NAS 服务。

## 镜像与环境

- `Dockerfile` 的 `unraid` target 沿用上游完整前后端构建，预装当前启用的 QQ、Telegram、WebSocket、微信渠道依赖；用户固定 `99:100`，补充组 `281` 保留 Docker socket 权限。
- 与 lover 一样，容器内 nanobot 用户和同名组均映射到宿主 Unraid nobody/users 的数字身份 99:100，供 SMB/Windows 共享按既有权限访问创建的文件。root 降权和所有权修复读取实际 UID/GID，不再使用 1000:1000；不批量修改现有文件权限或共享 ACL。
- 保留现有数据、SSH、笔记库、SSD、HDD、Clouddrive 和 Docker socket 挂载，以及 NAS 已使用的 bubblewrap 权限。WebSocket 端口仍为 8765，API 仅在 `api` profile 开启时启动。
- `/home/nanobot/src` 保留为代码访问目录。运行代码和 WebUI 使用镜像中的版本，不设置旧 `PYTHONPATH`；修改代码后重新构建镜像。
- `rg` 和 FFmpeg 在基础镜像中；Unraid 保留 curl 等启动工具。所有技能与网关共用 `/app/.venv`，不为技能新建环境。
- 与 lover 一样，entrypoint 在非 root 身份下执行 `$HOME/.nanobot/workspace/scripts/bootstrap.sh`，成功后才启动 nanobot；失败则停止启动。root 启动也先降权再执行，不以 root 安装 workspace 技能依赖。
- 具体依赖、外部工具及安装检查只在 workspace bootstrap 和 `config/python-requirements.txt` 维护，不进入项目 Dockerfile。容器重建后由统一入口补齐；需要联网下载时沿用代理。浏览器等技能的系统依赖也由该环境维护流程负责，不能仅凭 Python 包安装成功认定可用。
- `tools.exec.allowedEnvKeys` 保留 PATH、VIRTUAL_ENV 及代理变量，`pathAppend` 保留两个工具目录；只设置 Docker ENV 不够。NAS 已备份并更新这些设置。默认 exec 不使用登录 shell；不要用 login=true 重置共用 Python 路径。
- NAS bootstrap 已修正 Python 路径优先级，以及 SSH key 不存在时导致启动退出的问题；没有在当前服务里实际执行安装。
- 用户决定暂缓浏览器依赖，等待知乎脚本调整；目前不承诺容器内 Chromium 抓取可用。
- 将旧 compose 中的 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`OAUTH_CLI_KIT_TOKEN_PATH` 原值保存在根目录 `.env.unraid`。该文件已排除 Git 和镜像构建上下文。不要设置 `PYTHONPATH`。`NO_PROXY` 保留现有局域网地址，确保固定 Ollama 地址直连；构建代理按 Docker/BuildKit 的代理设置配置。
- 不移动 `.nanobot/media`、认证和 WebUI 数据。日记仍为 `/home/nanobot/note/日记`；旧 TTS 历史引用的媒体路径保持不变。

## 升级步骤（在 NAS shell 手动执行）

用户手动暂停旧服务后再迁移。旧版使用源码挂载，必须先停掉所有使用该数据目录的 gateway/API/CLI 进程，再切换代码。记录旧镜像并备份整个 `.nanobot`（含隐藏文件、权限、软链接），备份放仓库之外。例如，在原仓库根目录执行：

```sh
set -e
backup="../nanobot-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
docker inspect --format '{{.Image}}' nanobot-gateway > "$backup/image-id"
docker image tag "$(cat "$backup/image-id")" "nanobot-lover-rollback:$(basename "$backup")"
# 使用原部署配置停止服务，避免误停其他容器。
docker compose -f docker-compose.yml stop nanobot-gateway nanobot-api
tar -cpf "$backup/nanobot-data.tar" .nanobot
tar -tf "$backup/nanobot-data.tar" >/dev/null
```

旧 Dockerfile、compose、entrypoint 和对应代码版本也应放入该备份目录。NAS 原容器通过源码挂载运行，只有镜像备份不足以回退。

备份完成后准备 lover-next 代码及 `.env.unraid`，不要用强制 checkout 丢弃原部署修改。然后构建：

```sh
docker compose -f docker-compose.unraid.yml config --quiet
docker compose -f docker-compose.unraid.yml build nanobot-gateway
```

当前 NAS config 的唯一 schema 阻断项为根级 `desk_pet`。在完整备份之后移除该字段（伴侣视频已改为 Electron 本地配置），保留所有其他配置及密钥：

```sh
docker compose -f docker-compose.unraid.yml run --rm -T --no-deps \
  --entrypoint python nanobot-cli - <<'PY'
import json, os
from pathlib import Path
path = Path('/home/nanobot/.nanobot/config.json')
data = json.loads(path.read_text(encoding='utf-8-sig'))
data.pop('desk_pet', None)
exec_config = data.setdefault('tools', {}).setdefault('exec', {})
keys = ['PATH', 'VIRTUAL_ENV', 'PLAYWRIGHT_BROWSERS_PATH', 'HTTP_PROXY',
        'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'TZ']
exec_config['allowedEnvKeys'] = list(dict.fromkeys(exec_config.get('allowedEnvKeys', []) + keys))
paths = exec_config.get('pathAppend', '').split(':')
paths += ['/home/nanobot/.nanobot/workspace/bin', '/home/nanobot/.local/bin']
exec_config['pathAppend'] = ':'.join(dict.fromkeys(p for p in paths if p))
from nanobot.config.loader import _migrate_config
from nanobot.config.schema import Config, _resolve_tool_config_refs
from pydantic import ValidationError
_resolve_tool_config_refs()
try:
    Config.model_validate(_migrate_config(data))
except ValidationError as exc:
    raise SystemExit(str([(e['loc'], e['type']) for e in exc.errors(include_input=False)]))
temporary = path.with_suffix('.json.upgrade')
with temporary.open('w', encoding='utf-8') as stream:
    os.chmod(temporary, path.stat().st_mode & 0o777)
    json.dump(data, stream, ensure_ascii=False, indent=2)
    stream.write('\n')
    stream.flush()
    os.fsync(stream.fileno())
temporary.replace(path)
PY
```

先在新镜像中验证环境（不启动渠道），再启动 gateway。第二条验证通过真实 ExecTool 的过滤环境检查共用 Python 和工具路径；具体技能依赖由 workspace bootstrap 检查：

```sh
docker compose -f docker-compose.unraid.yml run --rm --no-deps nanobot-cli status
docker compose -f docker-compose.unraid.yml run --rm --no-deps --entrypoint python nanobot-cli /home/nanobot/src/deploy/verify_unraid.py
docker compose -f docker-compose.unraid.yml run --rm --no-deps --entrypoint sh nanobot-cli -ec '
  test "$(id -u):$(id -g)" = 99:100
  test -w /home/nanobot/.nanobot
  test -w /app/.venv
  test -r /home/nanobot/note/日记
  for tool in rg ffmpeg ffprobe curl jq sqlite3 himalaya docker; do command -v "$tool"; done
'
docker compose -f docker-compose.unraid.yml up -d --no-deps nanobot-gateway
docker compose -f docker-compose.unraid.yml logs --tail=100 nanobot-gateway
```

如旧部署与新部署使用不同 Compose project name，需沿用原 `-p` 名称，避免固定容器名冲突。不要同时运行新旧 gateway。

## 数据迁移和回退

- 上游自动把 `workspace/sessions/*.jsonl` 移到 `.nanobot/sessions/<workspace-id>/`，工作区身份标记也必须保留。在临时副本中，65 个现有 NAS 会话迁移前后 SHA-256 全部一致。
- 月度原文归档仍在 `workspace/sessions` 的归档子目录，不加入历史读取。日语进度仍在 `workspace/memory/japanese-learning-state.json` 和 `japanese-learning.md`；技能业务数据仍在 `workspace/data`。
- NAS 定时任务已位于 `workspace/cron/jobs.json`，无需再次迁移；只有旧 `.nanobot/cron/jobs.json` 存在且目标不存在时，上游才会自动移动。
- 不依赖 `nanobot sessions restore-workspace` 完成 lover 回退：它只识别新版编码文件名，旧命名会话的副本实验未能全部恢复。回退时先停新服务，另行保存升级后的整个 `.nanobot`，再恢复升级前的完整数据、原代码及部署文件。不要直接覆盖或删除升级后数据，避免丢失试运行期间的新消息。
- 实机验收：渠道登录、Electron 连接和统一收件箱、旧历史及 TTS 回放、日记召回、定时任务、日语进度、工作区工具与 Docker socket。确认稳定前不要删除回退备份。

本机 Docker daemon 未启动，当前无法做 Linux 镜像构建和 Unraid 实机验收；这些检查必须在实际部署时完成。
