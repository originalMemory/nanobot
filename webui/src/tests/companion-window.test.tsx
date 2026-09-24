import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { DetachedCompanion } from "@/companion";
import type { CompanionPrefs } from "@/lib/runtime";

afterEach(() => { Reflect.deleteProperty(window, "companionWindow"); });

it("switches the scene and rotation mode from the detached window", async () => {
  let prefs: CompanionPrefs = {
    enabled: true, directory: "/videos", scene: "glasshouse",
    rotationMode: "manual", rotationHours: 2,
    schedule: { sunrise: "05:00", day: "10:00", sunset: "18:00", night: "22:00" },
    panel: { x: null, y: null, width: 288, collapsed: false },
  };
  const save = vi.fn(async (patch: Partial<CompanionPrefs>) => (prefs = { ...prefs, ...patch }));
  const available = [
    { id: "glasshouse", displayName: "Glasshouse" },
    { id: "lakeside", displayName: "Lakeside" },
  ];
  const packs = vi.fn(async () => [...available]);
  let onChanged: (next: CompanionPrefs) => void = () => {};
  Reflect.set(window, "companionWindow", {
    read: async () => prefs,
    packs,
    videos: async () => ({ idle: [], working: [], fallback: { idle: [], working: [] }, labels: {}, segment: "day", error: false }),
    save,
    setAspectRatio: async () => {},
    onWorking: () => () => {},
    onChanged: (listener: (next: CompanionPrefs) => void) => { onChanged = listener; return () => {}; },
  });
  render(<DetachedCompanion />);

  fireEvent.click(await screen.findByRole("combobox", { name: "Video scene" }));
  fireEvent.click(await screen.findByRole("option", { name: "Lakeside" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ scene: "lakeside" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Video scene" })).toHaveTextContent("Lakeside"));

  fireEvent.click(screen.getByRole("combobox", { name: "Scene rotation" }));
  fireEvent.click(await screen.findByRole("option", { name: "Sequential" }));
  await waitFor(() => expect(save).toHaveBeenCalledWith({ rotationMode: "sequential" }));
  await waitFor(() => expect(screen.getByRole("combobox", { name: "Scene rotation" })).toHaveTextContent("Sequential"));

  available.push({ id: "new-scene", displayName: "New scene" });
  prefs = { ...prefs, scene: "new-scene" };
  act(() => onChanged(prefs));
  expect(screen.getByRole("combobox", { name: "Video scene" })).toHaveTextContent("new-scene");
  fireEvent.click(screen.getByRole("combobox", { name: "Video scene" }));
  expect(await screen.findByRole("option", { name: "New scene" })).toBeInTheDocument();
  expect(document.querySelector('[aria-label="Video scene"]')).toHaveTextContent("New scene");
  expect(packs).toHaveBeenCalledTimes(3);
});
