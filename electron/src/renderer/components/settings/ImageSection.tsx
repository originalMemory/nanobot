import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ImageGenerationSettingsUpdate, SettingsPayload } from "@/lib/types";
import {
  IMAGE_ASPECT_RATIO_OPTIONS,
  IMAGE_SIZE_OPTIONS,
  NumberInput,
  ProviderPicker,
  ReadOnlyRow,
  RestartSettingsFooter,
  SettingsGroup,
  SettingsRow,
  SettingsSectionTitle,
  StatusPill,
  ToggleButton,
} from "./shared";

function optionRowsWithCurrent(
  options: Array<{ name: string; label: string }>,
  value: string,
): Array<{ name: string; label: string }> {
  if (!value || options.some((o) => o.name === value)) return options;
  return [{ name: value, label: value }, ...options];
}

interface ImageSectionProps {
  settings: SettingsPayload;
  showBrandLogos: boolean;
  pendingRestart: boolean;
  onRestart?: () => void;
  isRestarting?: boolean;
  onOpenProviders: () => void;
  onSave: (update: ImageGenerationSettingsUpdate) => Promise<void>;
}

export function ImageSection({
  settings,
  showBrandLogos,
  pendingRestart,
  onRestart,
  isRestarting,
  onOpenProviders,
  onSave,
}: ImageSectionProps) {
  const { t } = useTranslation();
  const tx = (key: string, fallback: string) => t(key, { defaultValue: fallback });

  const [form, setForm] = useState<ImageGenerationSettingsUpdate>({
    enabled: settings.image_generation.enabled,
    provider: settings.image_generation.provider,
    model: settings.image_generation.model,
    defaultAspectRatio: settings.image_generation.default_aspect_ratio,
    defaultImageSize: settings.image_generation.default_image_size,
    maxImagesPerTurn: settings.image_generation.max_images_per_turn,
  });
  const [saving, setSaving] = useState(false);

  const dirty = useMemo(() => {
    const ig = settings.image_generation;
    return (
      form.enabled !== ig.enabled ||
      form.provider !== ig.provider ||
      form.model !== ig.model ||
      form.defaultAspectRatio !== ig.default_aspect_ratio ||
      form.defaultImageSize !== ig.default_image_size ||
      form.maxImagesPerTurn !== ig.max_images_per_turn
    );
  }, [form, settings]);

  const selectedProvider =
    settings.image_generation.providers.find((p) => p.name === form.provider) ??
    settings.image_generation.providers[0];
  const providerConfigured = !!selectedProvider?.configured;
  const missingCredential = form.enabled && !providerConfigured;

  const aspectOptions = optionRowsWithCurrent(
    IMAGE_ASPECT_RATIO_OPTIONS.map((v) => ({ name: v, label: v })),
    form.defaultAspectRatio,
  );
  const sizeOptions = optionRowsWithCurrent(
    IMAGE_SIZE_OPTIONS.map((v) => ({ name: v, label: v })),
    form.defaultImageSize,
  );

  const handleSave = async () => {
    if (!dirty || saving || missingCredential) return;
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-7">
      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.imageGeneration", "Image generation")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.imageGeneration", "Image generation")}
            description={tx(
              "settings.help.imageGeneration",
              "Expose generate_image in chats when a configured image provider is available.",
            )}
          >
            <ToggleButton
              checked={form.enabled}
              onChange={(enabled) => setForm((prev) => ({ ...prev, enabled }))}
              ariaLabel={tx("settings.rows.imageGeneration", "Image generation")}
              label={form.enabled ? tx("settings.values.on", "On") : tx("settings.values.off", "Off")}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.imageProvider", "Image provider")}
            description={tx(
              "settings.help.imageProvider",
              "Choose the registry provider used by generate_image.",
            )}
          >
            <ProviderPicker
              providers={settings.image_generation.providers}
              value={form.provider}
              emptyLabel={tx("settings.image.selectProvider", "Select provider")}
              showProviderLogos={showBrandLogos}
              onChange={(provider) => setForm((prev) => ({ ...prev, provider }))}
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.imageProviderStatus", "Provider status")}
            description={tx(
              "settings.help.imageProviderStatus",
              "Image generation reuses provider credentials from Providers.",
            )}
          >
            <div className="flex flex-wrap items-center justify-end gap-2">
              <StatusPill tone={providerConfigured ? "success" : "neutral"}>
                {providerConfigured
                  ? tx("settings.values.configured", "Configured")
                  : tx("settings.values.notConfigured", "Not configured")}
              </StatusPill>
              {!providerConfigured ? (
                <Button size="sm" variant="outline" onClick={onOpenProviders} className="rounded-full">
                  {tx("settings.image.configureProvider", "Configure provider")}
                </Button>
              ) : null}
            </div>
          </SettingsRow>
          <ReadOnlyRow
            title={tx("settings.rows.imageProviderBase", "Provider base")}
            value={
              selectedProvider?.api_base ||
              selectedProvider?.default_api_base ||
              selectedProvider?.name ||
              tx("settings.values.notAvailable", "Not available")
            }
          />
        </SettingsGroup>
      </section>

      <section>
        <SettingsSectionTitle>
          {tx("settings.sections.imageDefaults", "Defaults")}
        </SettingsSectionTitle>
        <SettingsGroup>
          <SettingsRow
            title={tx("settings.rows.imageModel", "Image model")}
            description={tx(
              "settings.help.imageModel",
              "Model name sent to the selected image provider.",
            )}
          >
            <Input
              value={form.model}
              onChange={(e) => setForm((prev) => ({ ...prev, model: e.target.value }))}
              className="h-8 w-[min(300px,70vw)] rounded-full text-[13px]"
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.defaultAspectRatio", "Default aspect")}
            description={tx(
              "settings.help.defaultAspectRatio",
              "Used when the prompt does not choose an aspect ratio.",
            )}
          >
            <ProviderPicker
              providers={aspectOptions}
              value={form.defaultAspectRatio}
              emptyLabel={tx("settings.image.selectAspect", "Select aspect")}
              onChange={(defaultAspectRatio) =>
                setForm((prev) => ({ ...prev, defaultAspectRatio }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.defaultImageSize", "Default size")}
            description={tx(
              "settings.help.defaultImageSize",
              "Size hint sent to providers that support it.",
            )}
          >
            <ProviderPicker
              providers={sizeOptions}
              value={form.defaultImageSize}
              emptyLabel={tx("settings.image.selectSize", "Select size")}
              onChange={(defaultImageSize) =>
                setForm((prev) => ({ ...prev, defaultImageSize }))
              }
            />
          </SettingsRow>
          <SettingsRow
            title={tx("settings.rows.maxImagesPerTurn", "Max images per turn")}
            description={tx(
              "settings.help.maxImagesPerTurn",
              "Upper bound for one generate_image request.",
            )}
          >
            <NumberInput
              value={form.maxImagesPerTurn}
              min={1}
              max={8}
              onChange={(maxImagesPerTurn) =>
                setForm((prev) => ({ ...prev, maxImagesPerTurn }))
              }
            />
          </SettingsRow>
          <ReadOnlyRow
            title={tx("settings.rows.imageSaveDir", "Save directory")}
            value={settings.image_generation.save_dir}
          />
          <RestartSettingsFooter
            dirty={dirty}
            saving={saving}
            pendingRestart={pendingRestart}
            disabled={missingCredential}
            message={
              missingCredential
                ? tx(
                    "settings.image.missingCredential",
                    "Configure this provider before enabling image generation.",
                  )
                : undefined
            }
            dirtyMessage={tx(
              "settings.status.restartAfterSaving",
              "Save changes, then restart when ready.",
            )}
            pendingMessage={tx("settings.status.savedRestartApply", "Saved. Restart when ready.")}
            onSave={() => void handleSave()}
            onRestart={onRestart}
            isRestarting={isRestarting}
          />
        </SettingsGroup>
      </section>
    </div>
  );
}
