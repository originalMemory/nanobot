# Spec: docker-source-hot-reload

## Why
- v0.3.0 merge 后容器改为运行镜像内已安装代码，源码映射不再生效
- `cap_drop: ALL` 阻断 entrypoint 的 `chown` 和 `setpriv`，gateway 无法启动
- 源码目录不包含被忽略的 WebUI `dist`，恢复 `PYTHONPATH` 后访问 `/` 返回 404

## Scope
- 恢复 `/home/nanobot/src` 源码优先加载
- 补充 entrypoint 降权所需 capability
- 源码 `dist` 缺失时回退镜像内 WebUI 构建产物
- 不改运行账号、UID/GID、挂载目录权限和 entrypoint 降权流程

## Plan
- [x] 在 Dockerfile 恢复源码目录 `PYTHONPATH`
- [x] 在 compose 增加 `CHOWN`、`SETUID`、`SETGID`
- [x] 为镜像内 WebUI `dist` 声明路径
- [x] 静态资源定位支持镜像路径回退
- [x] 增加源码 `dist` 缺失场景测试

## Apply Notes
- 保留镜像内依赖与 console script；源码通过 `PYTHONPATH` 覆盖已安装包
- 保留 `cap_drop: ALL`，仅开放启动降权必需能力
- 本机无 Docker CLI；compose 用 YAML 解析和 capability 断言验证
- 源码构建产物优先；仅在其不存在时读取 `NANOBOT_WEBUI_DIST`

## Verify
- [x] compose YAML 可解析
- [x] Dockerfile 环境变量指向源码挂载目录
- [x] compose capability 覆盖 `chown` 与 `setpriv`
- [x] 源码 `dist` 存在时保持优先
- [x] 源码 `dist` 缺失时返回镜像回退目录
- [x] 相关测试与 lint 通过

## Status
- State: done
- Archived: yes
