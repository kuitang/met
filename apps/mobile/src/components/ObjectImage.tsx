/**
 * ObjectImage / ObjectThumb — every object picture in the app renders
 * through these two components.
 *
 * Image bytes come from the public Tigris CDN bucket first (pre-generated
 * derivatives addressed by objects.thumbKey: c1080 hero here, t320 for the
 * list-row ObjectThumb), bypassing the app server entirely. The server's
 * /api/v1/img proxy is the web fallback only — for objects without a
 * thumbKey yet (newer than the last thumbnail run) and for bucket load
 * errors; native falls back to the direct Met CDN (no COEP there). The full
 * source-resolution policy, the crossorigin="anonymous" requirement for
 * bucket loads under COEP `require-corp`, and the stub-provider exception
 * live in ONE module: see src/data/imageCdn.ts.
 *
 * Hero loading state: cold loads can take a second-plus, so the fixed-height
 * frame shows a neutral block with a small Met-red spinner until the bytes
 * paint — intentional, no layout shift. The neutral block is also the
 * exhausted-chain error state.
 */
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Platform,
  StyleSheet,
  View,
  type ImageStyle,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { imageSources, needsCrossOrigin, type ImageVariant } from '@/data/imageCdn';
import { useData, type MetObject } from '@/data/provider';
import { colors } from '@/theme';

type ImgObject = Pick<MetObject, 'objectID' | 'img' | 'thumbKey'>;

/** Walk the candidate chain (CDN derivative → proxy / Met CDN) on error. */
function useImageChain(o: ImgObject, variant: ImageVariant) {
  const { dataVersion } = useData();
  const [failed, setFailed] = useState(0);
  const urls = imageSources(o, variant, dataVersion);
  const exhausted = failed >= urls.length;
  return {
    src: urls[Math.min(failed, urls.length - 1)],
    exhausted,
    advance: () => setFailed((n) => n + 1),
  };
}

/**
 * List-row thumbnail (t320). Renders the caller's `style` box (width/height/
 * background) on both platforms; web uses a raw <img> because react-native-web
 * Image cannot set crossorigin (required for bucket loads under COEP).
 * Callers still handle the no-image case (`object.img === ''`) themselves.
 */
export function ObjectThumb({
  object,
  style,
}: {
  object: ImgObject;
  style: StyleProp<ViewStyle>;
}) {
  const { src, exhausted, advance } = useImageChain(object, 't320');
  if (exhausted) return <View style={style} />; // neutral block, caller bg
  if (Platform.OS === 'web') {
    return (
      <View style={style}>
        <img
          src={src}
          key={src}
          alt=""
          data-testid="object-thumb"
          crossOrigin={needsCrossOrigin(src) ? 'anonymous' : undefined}
          onError={advance}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: src }}
      style={style as StyleProp<ImageStyle>}
      resizeMode="cover"
      onError={advance}
      testID="object-thumb"
    />
  );
}

/** Object-detail hero image (c1080). */
export default function ObjectImage({ object }: { object: ImgObject }) {
  const { src, exhausted, advance } = useImageChain(object, 'c1080');
  const [loaded, setLoaded] = useState(false);
  const done = () => setLoaded(true);

  let img: React.ReactNode = null;
  if (exhausted) {
    // Chain exhausted: keep the neutral frame, no spinner.
    img = null;
  } else if (Platform.OS === 'web') {
    img = (
      <img
        src={src}
        key={src}
        alt=""
        data-testid="object-image"
        crossOrigin={needsCrossOrigin(src) ? 'anonymous' : undefined}
        onLoad={done}
        onError={advance}
        // Browser-cached images can be complete before React attaches onLoad.
        ref={(el) => {
          if (el?.complete && el.naturalWidth > 0) setLoaded(true);
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
        source={{ uri: src }}
        style={styles.image}
        resizeMode="contain"
        onLoad={done}
        onError={advance}
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
          {!exhausted && <ActivityIndicator color={colors.red} size="small" />}
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
