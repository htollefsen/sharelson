import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { Button } from "@/components/button";
import {
  type DriveFile,
  DriveError,
  getFolder,
  listSharedDrives,
  listSharedWithMeFolders,
  listSubfolders,
  MY_DRIVE_ROOT,
} from "@/lib/drive";
import { getCurrentUser, signIn } from "@/lib/google-auth";
import { parseFolderId, setFolder } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

type Step = "sign-in" | "folder";

/** A place in the Drive hierarchy the folder browser can show. */
type Location = { id: string; name: string; kind: "my-drive" | "shared-with-me" | "shared-drive" | "folder" };

/** What the folder browser shows at `location`; the top level lists the places to start from. */
async function fetchEntries(location: Location | null): Promise<Location[]> {
  if (!location) {
    const drives = await listSharedDrives();
    return [
      { id: MY_DRIVE_ROOT, name: "My Drive", kind: "my-drive" },
      { id: "shared-with-me", name: "Shared with me", kind: "shared-with-me" },
      ...drives.map((d) => ({ id: d.id, name: d.name, kind: "shared-drive" as const })),
    ];
  }
  const folders: DriveFile[] =
    location.kind === "shared-with-me" ? await listSharedWithMeFolders() : await listSubfolders(location.id);
  return folders.map((f) => ({ id: f.id, name: f.name, kind: "folder" as const }));
}

const errorText = (e: unknown) => (e instanceof DriveError || e instanceof Error ? e.message : String(e));

/**
 * First-run wizard: sign in with Google, then pick the Drive folder uploads go to. The home
 * screen sends the user here until both are done. Settings opens it with `?step=folder` to
 * change the folder only.
 */
export default function Setup() {
  const router = useRouter();
  const { step: requestedStep } = useLocalSearchParams<{ step?: string }>();
  const changingFolder = requestedStep === "folder";

  const [email, setEmail] = useState<string | null>(getCurrentUser()?.user.email ?? null);
  const step: Step = email ? "folder" : "sign-in";

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Folder browser state: the trail of locations entered so far (empty = the top level).
  const [trail, setTrail] = useState<Location[]>([]);
  const [entries, setEntries] = useState<Location[] | null>(null);
  const [linkInput, setLinkInput] = useState("");

  const current = trail[trail.length - 1] ?? null;

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      const user = await signIn();
      setEmail(user?.user.email ?? null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  // Load the folder list for the current location; a stale response is dropped if the user
  // navigated on before it arrived.
  useEffect(() => {
    if (step !== "folder") return;
    let cancelled = false;
    fetchEntries(current).then(
      (result) => {
        if (!cancelled) setEntries(result);
      },
      (e: unknown) => {
        if (cancelled) return;
        setEntries([]);
        setError(errorText(e));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [step, current]);

  function enter(location: Location) {
    setEntries(null);
    setError(null);
    setTrail((t) => [...t, location]);
  }

  function back() {
    setEntries(null);
    setError(null);
    setTrail((t) => t.slice(0, -1));
  }

  async function choose(folder: { id: string; name: string }) {
    setBusy(true);
    setError(null);
    try {
      await setFolder(folder);
      router.replace(changingFolder ? "/settings" : "/");
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  async function chooseFromLink() {
    const id = parseFolderId(linkInput);
    if (!id) {
      setError("Paste a Drive folder link or folder ID");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const folder = await getFolder(id);
      await choose({ id: folder.id, name: folder.name });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  // Only a real folder (My Drive root, a shared drive, or a folder) can be the upload target.
  const canChooseCurrent = current !== null && current.kind !== "shared-with-me";

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {!changingFolder ? (
        <View style={local.steps}>
          <Text style={[local.step, step === "sign-in" && local.stepActive]}>1. Google account</Text>
          <Text style={[local.step, step === "folder" && local.stepActive]}>2. Drive folder</Text>
        </View>
      ) : null}

      {step === "sign-in" ? (
        <View style={styles.card}>
          <Text style={styles.title}>Sign in with Google</Text>
          <Text style={styles.body}>
            Sharelsen uploads what you share to a Google Drive folder using your own Google account. Use an
            account that has edit access to the folder you want to use.
          </Text>
          <Button title="Sign in with Google" onPress={handleSignIn} busy={busy} />
          {error ? <Text style={[styles.muted, { color: colors.error }]}>{error}</Text> : null}
        </View>
      ) : (
        <>
          <View style={styles.card}>
            <Text style={styles.title}>{current ? current.name : "Choose a Drive folder"}</Text>
            <Text style={styles.muted}>
              {current
                ? "Open a subfolder, or use this folder for uploads."
                : `Signed in as ${email}. Browse to the folder that should receive your uploads.`}
            </Text>

            {entries === null ? <Text style={styles.muted}>Loading…</Text> : null}
            {entries && entries.length === 0 && !error ? <Text style={styles.muted}>No folders here.</Text> : null}
            {entries?.map((entry) => (
              <Pressable key={entry.id} onPress={() => enter(entry)} disabled={busy} style={local.row}>
                <Text style={local.rowIcon}>{entry.kind === "folder" ? "📁" : entry.kind === "my-drive" ? "🗂️" : "👥"}</Text>
                <Text style={[styles.body, { flex: 1 }]} numberOfLines={1}>
                  {entry.name}
                </Text>
                <Text style={styles.muted}>›</Text>
              </Pressable>
            ))}
            {error ? <Text style={[styles.muted, { color: colors.error }]}>{error}</Text> : null}

            {current ? (
              <View style={styles.buttonRow}>
                <View style={styles.buttonRowItem}>
                  <Button title="Back" variant="secondary" onPress={back} disabled={busy} />
                </View>
                {canChooseCurrent ? (
                  <View style={styles.buttonRowItem}>
                    <Button title="Use this folder" onPress={() => choose(current)} busy={busy} />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>

          {!current ? (
            <View style={styles.card}>
              <Text style={styles.title}>Or paste a folder link</Text>
              <TextInput
                style={styles.input}
                value={linkInput}
                onChangeText={setLinkInput}
                placeholder="https://drive.google.com/drive/folders/…"
                placeholderTextColor={colors.muted}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Button title="Use this link" variant="secondary" onPress={chooseFromLink} busy={busy} />
            </View>
          ) : null}

          {changingFolder ? (
            <Button title="Cancel" variant="secondary" onPress={() => router.back()} disabled={busy} />
          ) : null}
        </>
      )}
    </ScrollView>
  );
}

const local = StyleSheet.create({
  steps: { flexDirection: "row", gap: 16 },
  step: { fontSize: 14, color: colors.muted, fontWeight: "600" },
  stepActive: { color: colors.primary },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowIcon: { fontSize: 18 },
});
