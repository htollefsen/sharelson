import { openURL } from "expo-linking";
import { useFocusEffect, useRouter } from "expo-router";
import { useShareIntentContext } from "expo-share-intent";
import { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, Text, View } from "react-native";

import { Button } from "@/components/button";
import { FileList } from "@/components/file-list";
import { type FolderListing, listFolder } from "@/lib/drive";
import { getCurrentUser } from "@/lib/google-auth";
import { getFolder, type SavedFolder } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

const RECENT_COUNT = 7;

function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

export default function Home() {
  const router = useRouter();
  const { hasShareIntent } = useShareIntentContext();

  const [signedIn, setSignedIn] = useState(Boolean(getCurrentUser()));
  const [folder, setFolder] = useState<SavedFolder | null>(null);
  const [checked, setChecked] = useState(false);
  const folderId = folder?.id ?? null;
  const [listing, setListing] = useState<FolderListing | null>(null);
  const [listBusy, setListBusy] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  // Setup must finish before anything else, including handling a share.
  const ready = signedIn && folder !== null;

  useEffect(() => {
    if (!checked) return;
    if (!ready) router.replace("/setup");
    else if (hasShareIntent) router.replace("/share");
  }, [checked, ready, hasShareIntent, router]);

  const loadListing = useCallback(async (id: string | null, isSignedIn: boolean) => {
    if (!id || !isSignedIn) {
      setListing(null);
      return;
    }
    setListBusy(true);
    setListError(null);
    try {
      setListing(await listFolder(id, RECENT_COUNT));
    } catch (e) {
      setListError(e instanceof Error ? e.message : String(e));
    } finally {
      setListBusy(false);
    }
  }, []);

  // Re-read account and folder whenever this screen is shown, e.g. after returning from
  // setup, settings or an upload.
  useFocusEffect(
    useCallback(() => {
      const isSignedIn = Boolean(getCurrentUser());
      setSignedIn(isSignedIn);
      getFolder().then((saved) => {
        setFolder(saved);
        setChecked(true);
        loadListing(saved?.id ?? null, isSignedIn);
      });
    }, [loadListing]),
  );

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
          <Text style={styles.title}>Latest in {folder?.name}</Text>
          {listError ? <Text style={[styles.muted, { color: colors.error }]}>{listError}</Text> : null}
          {listing && listing.files.length === 0 ? (
            <Text style={styles.muted}>Nothing here yet. Share a photo or video to Sharelsen to add one.</Text>
          ) : null}
          {listing ? <FileList files={listing.files} accessToken={listing.accessToken} /> : null}
          {!listing && listBusy ? <Text style={styles.muted}>Loading…</Text> : null}
          {listing && listing.files.length >= RECENT_COUNT ? (
            <Text style={styles.muted}>Showing the {RECENT_COUNT} most recent. Open the folder for everything.</Text>
          ) : null}
          <View style={styles.buttonRow}>
            <View style={styles.buttonRowItem}>
              <Button title="Open in Drive" onPress={() => folderId && openURL(driveFolderUrl(folderId))} />
            </View>
            <View style={styles.buttonRowItem}>
              <Button title="Refresh" variant="secondary" onPress={() => loadListing(folderId, signedIn)} busy={listBusy} />
            </View>
          </View>
        </View>
      ) : null}
    </ScrollView>
  );
}
