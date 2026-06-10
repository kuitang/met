import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { DataContext, StubDataProvider } from '@/data/provider';
import { colors, type } from '@/theme';

const provider = new StubDataProvider();

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }} testID="app-root">
      <DataContext.Provider value={provider}>
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
      </DataContext.Provider>
    </GestureHandlerRootView>
  );
}
