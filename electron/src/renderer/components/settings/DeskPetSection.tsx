import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { SettingsPayload, ThaSettingsUpdate, PsbSettingsUpdate } from "@/lib/types";

import { PsbSection } from "./PsbSection";
import { ThaSection } from "./ThaSection";
import { SegmentedControl } from "./shared";

type DeskPetTab = "psb" | "tha";

interface DeskPetSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSaveTha: (update: ThaSettingsUpdate) => Promise<void>;
  onSavePsb: (update: PsbSettingsUpdate) => Promise<void>;
  onRefreshSettings: () => Promise<void>;
}

/** 桌宠分区：PSB / THA 分段切换。 */
export function DeskPetSection({
  settings,
  token,
  apiBase,
  onSaveTha,
  onSavePsb,
  onRefreshSettings,
}: DeskPetSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });
  const [tab, setTab] = useState<DeskPetTab>("psb");

  return (
    <div className="space-y-6">
      <SegmentedControl
        value={tab}
        options={[
          { value: "psb", label: tx("settings.deskPet.tabs.psb", "PSB") },
          { value: "tha", label: tx("settings.deskPet.tabs.tha", "THA") },
        ]}
        onChange={(value) => setTab(value as DeskPetTab)}
      />
      {tab === "psb" ? (
        <PsbSection
          settings={settings}
          token={token}
          apiBase={apiBase}
          onSave={onSavePsb}
          onRefreshSettings={onRefreshSettings}
        />
      ) : (
        <ThaSection settings={settings} token={token} apiBase={apiBase} onSave={onSaveTha} />
      )}
    </div>
  );
}
