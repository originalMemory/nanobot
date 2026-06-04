import { normalizeHotkey, type Hotkey } from "@tanstack/react-hotkeys";

const ELECTRON_TO_HOTKEY_MODIFIER: Record<string, string> = {
  CmdOrCtrl: "Mod",
  CommandOrControl: "Mod",
  Command: "Meta",
  Cmd: "Meta",
  Control: "Control",
  Ctrl: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Option: "Alt",
};

const HOTKEY_TO_ELECTRON_MODIFIER: Record<string, string> = {
  Mod: "CmdOrCtrl",
  CommandOrControl: "CmdOrCtrl",
  Meta: "Command",
  Command: "Command",
  Cmd: "Command",
  Control: "Control",
  Ctrl: "Control",
  Shift: "Shift",
  Alt: "Alt",
  Option: "Alt",
};

/** electron-store / globalShortcut 加速器 → TanStack Hotkey（用于展示与录制状态）。 */
export function electronAcceleratorToHotkey(accelerator: string): Hotkey {
  const parts = accelerator.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return normalizeHotkey("Mod+Shift+E");
  const key = parts[parts.length - 1]!;
  const modifiers = parts.slice(0, -1).map(
    (part) => ELECTRON_TO_HOTKEY_MODIFIER[part] ?? part,
  );
  return normalizeHotkey([...modifiers, key].join("+"));
}

/** TanStack 录制结果 → Electron globalShortcut 加速器。 */
export function hotkeyToElectronAccelerator(hotkey: Hotkey): string {
  const parts = hotkey.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  return parts
    .map((part, index) => {
      if (index === parts.length - 1) return part;
      return HOTKEY_TO_ELECTRON_MODIFIER[part] ?? part;
    })
    .join("+");
}
