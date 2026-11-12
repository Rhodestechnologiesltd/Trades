import { Platform } from 'react-native';

export const colors = {
  brand: '#0E7C66',
  brandDark: '#095C4C',
  brandSoft: '#E3F4EF',
  accent: '#F2A93B',
  urgent: '#D64545',
  urgentSoft: '#FCE8E8',
  bg: '#F6F7F9',
  surface: '#FFFFFF',
  border: '#E3E6EA',
  text: '#14181F',
  textMuted: '#5D6673',
  textFaint: '#8C95A1',
  success: '#1F8F5F',
  successSoft: '#E2F5EB',
  warning: '#B7791F',
  warningSoft: '#FDF3E1',
  danger: '#C53030',
  dangerSoft: '#FDE8E8',
  info: '#2B6CB0',
  infoSoft: '#E6F0FA',
  neutralSoft: '#EEF0F3',
};

export const space = (n: number) => n * 4;
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 };
export const font = {
  family: Platform.select({ ios: 'System', android: 'sans-serif', default: 'System' }),
  h1: 26, h2: 20, h3: 17, body: 15, small: 13, tiny: 11,
};
export const shadow = Platform.select({
  ios: { shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
  android: { elevation: 2 },
  default: {},
});

export type Tone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';
export const toneColors: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: colors.textMuted, bg: colors.neutralSoft },
  info: { fg: colors.info, bg: colors.infoSoft },
  warning: { fg: colors.warning, bg: colors.warningSoft },
  success: { fg: colors.success, bg: colors.successSoft },
  danger: { fg: colors.danger, bg: colors.dangerSoft },
};
