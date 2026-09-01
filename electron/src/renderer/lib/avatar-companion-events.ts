// 数字伴侣配置变更通知：设置页/快捷开关写入后广播，订阅方免轮询刷新
type Listener = () => void;

const listeners = new Set<Listener>();

export function notifyAvatarCompanionPrefsChanged(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeAvatarCompanionPrefs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
