/**
 * ObjectImage — object-detail hero image.
 *
 * Web renders a plain no-cors <img>. We deliberately do NOT set
 * crossOrigin="anonymous": images.metmuseum.org serves no
 * Access-Control-Allow-Origin header at all (verified live 2026-06-10), so a
 * CORS-mode request can never succeed. Consequence for Phase 2: the prod
 * server's COEP must be `credentialless` (allows no-cors images), or images
 * must be proxied through /api — `require-corp` would block the Met CDN
 * entirely. See docs/mockup/README.md "Known gaps".
 */
import { Image, Platform, StyleSheet } from 'react-native';

import { colors } from '@/theme';

export default function ObjectImage({ uri }: { uri: string }) {
  if (Platform.OS === 'web') {
    return (
      <img
        src={uri}
        alt=""
        data-testid="object-image"
        style={{
          width: '100%',
          height: 280,
          objectFit: 'contain',
          display: 'block',
          backgroundColor: colors.surface,
        }}
      />
    );
  }
  return (
    <Image
      source={{ uri }}
      style={styles.image}
      resizeMode="contain"
      testID="object-image"
    />
  );
}

const styles = StyleSheet.create({
  image: {
    width: '100%',
    height: 280,
    backgroundColor: colors.surface,
  },
});
