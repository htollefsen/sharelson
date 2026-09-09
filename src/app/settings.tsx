import { useFocusEffect, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, ScrollView, Text, View } from "react-native";

import { Button } from "@/components/button";
import { getCurrentUser, resetSignIn } from "@/lib/google-auth";
import { clearSettings, getFolder, type SavedFolder } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

export default function Settings() {
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(getCurrentUser()?.user.email ?? null);
  const [folder, setFolder] = useState<SavedFolder | null>(null);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      setEmail(getCurrentUser()?.user.email ?? null);
      getFolder().then(setFolder);
    }, []),
  );

  async function reset() {
    setResetting(true);
    setError(null);
    try {
      await clearSettings();
      await resetSignIn();
      router.replace("/setup");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResetting(false);
    }
  }

  function confirmReset() {
    Alert.alert(
      "Reset Sharelsen?",
      "This signs out of Google and forgets the Drive folder. You will go through setup again. Nothing in Drive is deleted.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Reset", style: "destructive", onPress: () => void reset() },
      ],
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.title}>Google account</Text>
        <Text style={styles.body}>{email ? `Signed in as ${email}` : "Not signed in"}</Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Drive folder</Text>
        <Text style={styles.body}>{folder ? folder.name : "No folder chosen"}</Text>
        <Text style={styles.muted}>Everything you share to Sharelsen is uploaded here.</Text>
        <Button title="Change folder" variant="secondary" onPress={() => router.push("/setup?step=folder")} />
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>How it works</Text>
        <Text style={styles.body}>
          Open a photo, video, PDF or web page in any app, tap Share, and pick Sharelsen. It is uploaded to the
          Drive folder above. Files already in the folder are skipped.
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>Reset</Text>
        <Text style={styles.muted}>
          Sign out of Google and forget the Drive folder, then run setup again from the start.
        </Text>
        <Button title="Reset settings and sign-in" variant="secondary" onPress={confirmReset} busy={resetting} />
        {error ? <Text style={[styles.muted, { color: colors.error }]}>{error}</Text> : null}
      </View>
    </ScrollView>
  );
}
