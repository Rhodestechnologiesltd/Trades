import { Platform } from 'react-native';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import type { Api } from '@trades/shared';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true, shouldShowBanner: true, shouldShowList: true }),
});

/** Registers for push (FCM/APNs via Expo) and stores the token server-side (§H). */
export async function registerForPush(api: Api): Promise<string | null> {
  if (!Device.isDevice) return null;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', { name: 'Updates', importance: Notifications.AndroidImportance.DEFAULT });
    await Notifications.setNotificationChannelAsync('urgent-jobs', {
      name: 'Urgent jobs', importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 400, 200, 400], sound: 'default',
    });
  }
  const { status: existing } = await Notifications.getPermissionsAsync();
  const status = existing === 'granted' ? existing : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return null; // SMS + in-app feed remain as fallbacks
  const projectId = (Constants.expoConfig?.extra as any)?.eas?.projectId ?? Constants.easConfig?.projectId;
  const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
  await api.me.registerPushToken(token, Platform.OS === 'ios' ? 'ios' : 'android');
  return token;
}

/** Best-effort jailbreak/root signal for §J (reduced trust on precise location claims). */
export async function isRootedDevice(): Promise<boolean> {
  try { return await Device.isRootedExperimentalAsync(); } catch { return false; }
}

export function deviceName(): string {
  return [Device.manufacturer, Device.modelName].filter(Boolean).join(' ') || Platform.OS;
}
