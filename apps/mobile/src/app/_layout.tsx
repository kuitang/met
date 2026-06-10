import { router, Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { HomeGlyph } from '@/components/MapMarkers';
import { DataGate } from '@/data/DataGate';
import { colors, type } from '@/theme';

/**
 * One-tap return to the home map from any deep screen (user mandate): a
 * persistent house-glyph button in every non-home header, opposite the back
 * arrow. dismissTo('/') unwinds the stack to the map (or navigates there on a
 * cold deep link); the location anchor lives in the LocateState module store,
 * so it survives the dismissal untouched.
 */
function HomeHeaderButton() {
  return (
    <Pressable
      style={styles.homeBtn}
      onPress={() => router.dismissTo('/')}
      accessibilityLabel="Back to the map"
      testID="home-button"
    >
      <HomeGlyph size={22} color={colors.ink} />
    </Pressable>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }} testID="app-root">
      <DataGate>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerShadowVisible: false,
            headerTintColor: colors.ink,
            headerTitleStyle: {
              fontFamily: type.label.fontFamily,
              fontSize: 14,
              fontWeight: type.label.fontWeight,
            },
            contentStyle: { backgroundColor: colors.background },
            headerRight: () => <HomeHeaderButton />,
          }}
        >
          <Stack.Screen name="index" options={{ headerShown: false }} />
          <Stack.Screen name="search" options={{ title: 'SEARCH' }} />
          <Stack.Screen name="results" options={{ title: 'ALL RESULTS' }} />
          <Stack.Screen name="object/[id]" options={{ title: 'OBJECT' }} />
          <Stack.Screen name="route/[from]/[to]" options={{ title: 'DIRECTIONS' }} />
          <Stack.Screen
            name="locate"
            options={{ title: 'FIND MY LOCATION', presentation: 'modal' }}
          />
        </Stack>
      </DataGate>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  // Apple HIG: ≥44×44 pt tap target.
  homeBtn: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
