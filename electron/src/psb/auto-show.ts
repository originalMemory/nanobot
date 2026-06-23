import type { PsbDeskPetSettings } from './types';

/** 判断是否应在启动时自动打开 PSB 窗口。 */
export function shouldAutoOpenPsb(
  psb: PsbDeskPetSettings | null | undefined,
  temporarilyClosed: boolean,
): boolean {
  if (temporarilyClosed) return false;
  if (!psb?.autoShow) return false;
  const selected = psb.selectedModelId?.trim();
  if (!selected) return false;
  const model = psb.models?.find((item) => item.modelId === selected);
  return model?.compatible === true;
}
