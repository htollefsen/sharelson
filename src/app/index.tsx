import { useFocusEffect, useRouter } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Button } from "@/components/button";
import { FileList } from "@/components/file-list";
import { type FolderListing, listFolder } from "@/lib/drive";
import { getCurrentUser } from "@/lib/google-auth";
import { getFolderId } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

export default function Home() {
  const router = useRouter();
  const { hasShareIntent } = useShareIntentContext();

  const [signedIn, setSignedIn] = useState(Boolean(getCurrentUser()));
  const [folderId, setFolderId] = useState<string | null>(null);
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    if (hasShareIntent) router.replace("/share");
  }, [hasShareIntent, router]);

  const loadListing = useCallback(async (id: string | null, isSignedIn: boolean) => {
    if (!id || !isSignedIn) {
      setListing(null);
      return;
    }
    setListBusy(true);
    setListError(null);
    try {
      setListing(await listFolder(id));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListBusy(false);
    }
  }, []);

  // Re-read account and folder whenever this screen is shown, e.g. after returning from
  // settings or from an upload.
  useFocusEffect(
    useCallback(() => {
      const isSignedIn = Boolean(getCurrentUser());
      setSignedIn(isSignedIn);
      getFolderId().then((id) => {
        setFolderId(id);
        loadListing(id, isSignedIn);
      });
    }, [loadListing]),
  );

  const ready = signedIn && Boolean(folderId);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={
        <RefreshControl
          refreshing={listBusy && listing !== null}
          onRefresh={() => loadListing(folderId, signedIn)}
          enabled={ready}
        />
      }
    >
      {ready ? (
        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={[styles.title, { flex: 1 }]}>In the folder</Text>
            <Text style={styles.muted}>{listing ? `${listing.files.length}` : ""}</Text>
          </View>
          {listError ? <Text style={[styles.muted, { color: colors.error }]}>{listError}</Text> : null}
          {listing && listing.files.length === 0 ? (
            <Text style={styles.muted}>Nothing here yet. Share a photo to Sharelsen to add one.</Text>
          ) : null}
          {listing ? <FileList files={listing.files} accessToken={listing.accessToken} /> : null}
          {!listing && listBusy ? <Text style={styles.muted}>Loading…</Text> : null}
          <Button title="Refresh" variant="secondary" onPress={() => loadListing(folderId, signedIn)} busy={listBusy} />
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.title}>Finish setup</Text>
          <Text style={styles.body}>
            {!signedIn && !folderId
              ? "Sign in with Google and choose a Drive folder to start receiving photos."
              : !signedIn
                ? "Sign in with Google to start receiving photos."
                : "Choose a Drive folder to start receiving photos."}
          </Text>
          <Button title="Open settings" onPress={() => router.push("/settings")} />
        </View>
      )}
    </ScrollView>
  );
}
