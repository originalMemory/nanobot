import type { SettingsPayload, ThaSettingsUpdate, PsbSettingsUpdate } from "@/lib/types";

import { PsbSection } from "./PsbSection";
import { ThaSection } from "./ThaSection";

interface DeskPetSectionProps {
  settings: SettingsPayload;
  token: string;
  apiBase: string;
  onSaveTha: (update: ThaSettingsUpdate) => Promise<void>;
  onSavePsb: (update: PsbSettingsUpdate) => Promise<void>;
  onRefreshSettings: () => Promise<void>;
}

/** 桌宠分区：THA 与 PSB 子区。 */
export function DeskPetSection({
  settings,
  token,
  apiBase,
  onSaveTha,
  onSavePsb,
  onRefreshSettings,
}: DeskPetSectionProps) {
  return (
    <div className="space-y-8">
      <ThaSection settings={settings} token={token} apiBase={apiBase} onSave={onSaveTha} />
      <PsbSection
        settings={settings}
        token={token}
        apiBase={apiBase}
        onSave={onSavePsb}
        onRefreshSettings={onRefreshSettings}
      />
    </div>
  );
}
