import { describe, expect, it } from "vitest";

import {
  electronAcceleratorToHotkey,
  hotkeyToElectronAccelerator,
} from "@/lib/hotkey-accelerator";

describe("hotkey-accelerator", () => {
  it("round-trips default raise-inbox accelerator", () => {
    const electron = "CmdOrCtrl+Shift+E";
    const hotkey = electronAcceleratorToHotkey(electron);
    expect(hotkeyToElectronAccelerator(hotkey)).toBe(electron);
  });

  it("maps Mod to CmdOrCtrl", () => {
    expect(hotkeyToElectronAccelerator("Mod+Shift+K")).toBe("CmdOrCtrl+Shift+K");
  });
});
