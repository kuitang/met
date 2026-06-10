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
 */
import { Image, Platform, StyleSheet } from 'react-native';

import { apiBase } from '@/data/apiBase';
import { useData } from '@/data/provider';
import { colors } from '@/theme';

export default function ObjectImage({
  uri,
  objectID,
}: {
  uri: string;
  objectID: number;
}) {
  const { dataVersion } = useData();
  if (Platform.OS === 'web') {
    const src =
      dataVersion === 'stub'
        ? uri
        : `${apiBase()}/api/v1/img/${objectID}?v=${encodeURIComponent(dataVersion)}`;
    return (
      <img
        src={src}
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
