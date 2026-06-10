/**
 * ObjectImage — object-detail hero image.
 *
 * Image-proxy strategy (gate-review ACCEPTED; COEP `require-corp` stays):
 * images.metmuseum.org serves no Access-Control-Allow-Origin and no CORP
 * header (verified live 2026-06-10), so the prod server's
 * `Cross-Origin-Embedder-Policy: require-corp` (needed for
 * SharedArrayBuffer/expo-sqlite on web) would block the Met CDN entirely.
 * The server proxies images at GET /api/v1/img/{objectID} with ACAO * +
 * CORP cross-origin, which works same-origin in prod AND in the
 * cross-origin metro dev setup (:8081 page, :8787 API). On web we point at
 * the proxy with a ?v={dataVersion} cache-buster (objectID→image is
 * immutable per artifact version).
 *
 * Two deliberate exceptions:
 *  - Stub provider (dataVersion === 'stub'): the mockup runs without any
 *    API server, so fall back to the direct CDN URL as a plain no-cors
 *    <img> (the metro dev server is not cross-origin isolated, so it loads).
 *  - Native: no COEP there; load the CDN directly and save our Fly egress.
 *
 * Loading state: cold image-proxy fetches (CDN miss → disk cache fill) can
 * take a second-plus, so the fixed-height frame shows a neutral block with a
 * small Met-red spinner until the bytes paint — intentional, no layout shift.
 */
import { useState } from 'react';
import { ActivityIndicator, Image, Platform, StyleSheet, View } from 'react-native';

import { apiBase } from '@/data/apiBase';
import { useData } from '@/data/provider';
import { colors } from '@/theme';

/**
 * Resolve the URL an object picture loads from. Web (real provider) MUST go
 * through the server image proxy: the prod server's COEP `require-corp`
 * blocks the CORP-less Met CDN outright, so direct images.metmuseum.org
 * URLs render as permanently blank boxes (reproduced live on result-row
 * thumbnails, both engines). Stub mockup and native keep the direct CDN URL
 * (no COEP there; see header comment).
 */
export function objectImageSrc(
  uri: string,
  objectID: number,
  dataVersion: string,
): string {
  if (Platform.OS !== 'web' || dataVersion === 'stub') return uri;
  return `${apiBase()}/api/v1/img/${objectID}?v=${encodeURIComponent(dataVersion)}`;
}

export default function ObjectImage({
  uri,
  objectID,
}: {
  uri: string;
  objectID: number;
}) {
  const { dataVersion } = useData();
  const [loaded, setLoaded] = useState(false);
  // Spinner clears on error too: the neutral block is the error fallback.
  const done = () => setLoaded(true);

  let img: React.ReactNode;
  if (Platform.OS === 'web') {
    const src = objectImageSrc(uri, objectID, dataVersion);
    img = (
      <img
        src={src}
        alt=""
        data-testid="object-image"
        onLoad={done}
        onError={done}
        // Browser-cached images can be complete before React attaches onLoad.
        ref={(el) => {
          if (el?.complete) setLoaded(true);
        }}
        style={{
          width: '100%',
          height: 280,
          objectFit: 'contain',
          display: 'block',
        }}
      />
    );
  } else {
    img = (
      <Image
        source={{ uri }}
        style={styles.image}
        resizeMode="contain"
        onLoadEnd={done}
        testID="object-image"
      />
    );
  }

  return (
    <View style={styles.frame}>
      {img}
      {/* pointerEvents via style: the prop form logs an RN-web deprecation
          warning (LogBox badge → HIG sweep failure). */}
      {!loaded && (
        <View style={styles.placeholder}>
          <ActivityIndicator color={colors.red} size="small" />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // Fixed-height neutral frame — the image fades in over it, never reflows.
  frame: {
    width: '100%',
    height: 280,
    backgroundColor: colors.surface,
  },
  image: {
    width: '100%',
    height: 280,
  },
  placeholder: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    pointerEvents: 'none',
  },
});
