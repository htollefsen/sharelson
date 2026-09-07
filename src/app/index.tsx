import { useFocusEffect, useRouter } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";

import { Button } from "@/components/button";
import { DriveError, getFolder } from "@/lib/drive";
import { getCurrentUser, signIn, signOut } from "@/lib/google-auth";
import { clearFolderId, getDefaultFolderId, getFolderId, parseFolderId, setFolderId } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

export default function Home() {
  const router = useRouter();
  const { hasShareIntent } = useShareIntentContext();

  const [email, setEmail] = useState<string | null>(getCurrentUser()?.user.email ?? null);
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [savedFolderId, setSavedFolderId] = useState<string | null>(null);
  const [folderInput, setFolderInput] = useState("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [folderMessage, setFolderMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (hasShareIntent) router.replace("/share");
  }, [hasShareIntent, router]);

  useFocusEffect(
    useCallback(() => {
      getFolderId().then((id) => {
        setSavedFolderId(id);
        if (id) setFolderInput(id);
      });
      setEmail(getCurrentUser()?.user.email ?? null);
    }, []),
  );

  async function handleSignIn() {
    setAuthBusy(true);
    setAuthError(null);
    try {
      const user = await signIn();
      setEmail(user?.user.email ?? null);
    } catch (e) {
      setAuthError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSignOut() {
    setAuthBusy(true);
    try {
      await signOut();
      setEmail(null);
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleSaveFolder() {
    const id = parseFolderId(folderInput);
    if (!id) {
      setFolderMessage({ ok: false, text: "Paste a Drive folder link or folder ID" });
      return;
    }
    setFolderBusy(true);
    setFolderMessage(null);
    try {
      if (email) {
        const folder = await getFolder(id);
        setFolderMessage({ ok: true, text: `Saved. Uploads go to "${folder.name}".` });
      } else {
        setFolderMessage({ ok: true, text: "Saved. Sign in to verify access." });
      }
      await setFolderId(id);
      setSavedFolderId(id);
      setFolderInput(id);
    } catch (e) {
      const text = e instanceof DriveError ? e.message : e instanceof Error ? e.message : String(e);
      setFolderMessage({ ok: false, text });
    } finally {
      setFolderBusy(false);
    }
  }

  async function handleClearFolder() {
    await clearFolderId();
    const fallback = getDefaultFolderId();
    setSavedFolderId(fallback);
    setFolderInput(fallback ?? "");
    setFolderMessage(fallback ? { ok: true, text: "Reset to the default folder." } : null);
  }

  const ready = Boolean(email && savedFolderId);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.title}>How it works</Text>
        <Text style={styles.body}>
          Open a photo in any app, tap Share, and pick Sharelsen. The photo is uploaded to the Google
          Drive folder configured below.
        </Text>
        <Text style={[styles.muted, { color: ready ? colors.success : colors.error }]}>
          {ready ? "Ready to receive photos." : "Finish the two steps below before sharing."}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>1. Google account</Text>
        {email ? (
          <>
            <Text style={styles.body}>Signed in as {email}</Text>
            <Button title="Sign out" variant="secondary" onPress={handleSignOut} busy={authBusy} />
          </>
        ) : (
          <>
            <Text style={styles.muted}>Use an account that has edit access to the Drive folder.</Text>
            <Button title="Sign in with Google" onPress={handleSignIn} busy={authBusy} />
          </>
        )}
        {authError ? <Text style={[styles.muted, { color: colors.error }]}>{authError}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.title}>2. Drive folder</Text>
        <Text style={styles.muted}>The family folder is preset. Paste another Drive folder link or ID to change it.</Text>
        <TextInput
          style={styles.input}
          value={folderInput}
          onChangeText={setFolderInput}
          placeholder="https://drive.google.com/drive/folders/…"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Button title="Save" onPress={handleSaveFolder} busy={folderBusy} />
          </View>
          {savedFolderId && savedFolderId !== getDefaultFolderId() ? (
            <View style={{ flex: 1 }}>
              <Button title="Reset" variant="secondary" onPress={handleClearFolder} disabled={folderBusy} />
            </View>
          ) : null}
        </View>
        {folderMessage ? (
          <Text style={[styles.muted, { color: folderMessage.ok ? colors.success : colors.error }]}>
            {folderMessage.text}
          </Text>
        ) : null}
      </View>
    </ScrollView>
  );
}
