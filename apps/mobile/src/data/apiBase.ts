/**
 * apiBase — the origin where /api/v1/* lives. Resolution order:
 *
 *  1. EXPO_PUBLIC_API_URL (baked in at bundle time) — explicit override for
 *     native builds (release builds pointing at prod) and DEV web (metro
 *     :8081 page → :8787 API). Deliberately IGNORED in production web
 *     bundles: the web export must be origin-portable — the same dist serves
 *     the custom domain (musewalk.app) and ephemeral PR preview apps, so a
 *     baked absolute API origin would break every origin but one.
 *  2. Web: '' (same-origin). In production one server serves both the web
 *     export and /api.
 *  3. Native dev: the host the bundle was served from (metro's
 *     Constants.expoConfig.hostUri, e.g. "192.168.1.7:8081") with the API
 *     dev server's default port 8787 — the usual "both dev servers on the
 *     laptop" setup. If the host is not determinable (release build without
 *     the env), we throw: there is no safe default to guess.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

export function apiBase(): string {
  const env = process.env.EXPO_PUBLIC_API_URL;
  // On web, only dev bundles honor the override (see header). __DEV__ is
  // compile-time, so production web bundles tree-shake the env value away.
  if (env && (Platform.OS !== 'web' || __DEV__)) return env.replace(/\/+$/, '');
  if (Platform.OS === 'web') return '';
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  if (host) return `http://${host}:8787`;
  throw new Error(
    'EXPO_PUBLIC_API_URL must be set for native builds not served by metro.',
  );
}
