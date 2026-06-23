export type PsbOpenConfig = {
  url: string;
  token?: string;
  modelId?: string;
  width?: number;
  height?: number;
};

export type PsbWindowState = {
  x?: number;
  y?: number;
  width: number;
  height: number;
  scale: number;
};

export type PsbLocalPrefs = {
  window: PsbWindowState;
  temporarilyClosed: boolean;
};

export type DeskPetLocalPrefs = {
  psb: PsbLocalPrefs;
};

export type PsbDeskPetSettings = {
  autoShow?: boolean;
  selectedModelId?: string | null;
  models?: Array<{
    modelId: string;
    compatible?: boolean;
  }>;
};

export type PsbRuntimeAction = {
  type: string;
  payload?: Record<string, unknown>;
};

export const DEFAULT_PSB_LOCAL_PREFS: DeskPetLocalPrefs = {
  psb: {
    window: {
      width: 540,
      height: 540,
      scale: 1,
    },
    temporarilyClosed: false,
  },
};
