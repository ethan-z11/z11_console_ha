import type { LightDevice } from './types';

export type LightVariant = 'switch' | 'dimmable' | 'advanced';

export function getLightVariant(light: LightDevice): LightVariant {
  const modes = light.supportedColorModes;
  if (modes.some((mode) => ['color_temp', 'hs', 'rgb', 'xy', 'rgbw', 'rgbww'].includes(mode))) return 'advanced';
  if (modes.includes('brightness')) return 'dimmable';
  return 'switch';
}

export function supportsColorTemperature(light: LightDevice): boolean {
  return light.supportedColorModes.includes('color_temp');
}

export function supportsColor(light: LightDevice): boolean {
  return light.supportedColorModes.some((mode) => ['hs', 'rgb', 'xy', 'rgbw', 'rgbww'].includes(mode));
}
