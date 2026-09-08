import { Stack, useRouter } from "expo-router";
import { ShareIntentProvider } from "expo-share-intent";
import { StatusBar } from "expo-status-bar";

import { HeaderButton } from "@/components/header-button";
import { configureGoogle } from "@/lib/google-auth";
import { colors } from "@/lib/theme";

configureGoogle();

export default function RootLayout() {
  const router = useRouter();
  return (
    // resetOnBackground is off because Google's sign-in and consent screens
    // send the app to the background; the share intent must survive that.
    <ShareIntentProvider options={{ resetOnBackground: false, debug: __DEV__ }}>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen
          name="index"
          options={{
            title: "Sharelsen",
            headerRight: () => (
              <HeaderButton icon="settings-outline" label="Settings" onPress={() => router.push("/settings")} />
            ),
          }}
        />
        <Stack.Screen name="settings" options={{ title: "Settings" }} />
        <Stack.Screen name="share" options={{ title: "Upload to Drive", headerBackVisible: false }} />
      </Stack>
    </ShareIntentProvider>
  );
}
