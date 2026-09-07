import { useRouter } from "expo-router";
import { useShareIntentContext, type ShareIntentFile } from "expo-share-intent";
import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button } from "@/components/button";
import { uploadToFolder } from "@/lib/drive";
import { getCurrentUser, NotSignedInError, signIn } from "@/lib/google-auth";
import { getFolderId } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

type Status =
  | { kind: "pending" }
  | { kind: "uploading"; progress: number }
  | { kind: "done" }
  | { kind: "error"; message: string };

function fileLabel(file: ShareIntentFile, index: number): string {
  return file.fileName || `Photo ${index + 1}`;
}

function statusText(status: Status): string {
  switch (status.kind) {
    case "pending":
      return "Waiting";
    case "uploading":
      return `Uploading ${Math.round(status.progress * 100)}%`;
    case "done":
      return "Uploaded";
    case "error":
      return status.message;
  }
}

export default function Share() {
  const router = useRouter();
  const { shareIntent, resetShareIntent } = useShareIntentContext();
  const files = (shareIntent.files ?? []).filter((f) => f.mimeType?.startsWith("image/"));

  const [statuses, setStatuses] = useState<Status[]>(() => files.map(() => ({ kind: "pending" })));
  const [blocker, setBlocker] = useState<"none" | "no-folder" | "sign-in" | "running" | "finished">("none");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const setStatus = useCallback((index: number, status: Status) => {
    setStatuses((prev) => prev.map((s, i) => (i === index ? status : s)));
  }, []);

  const runUploads = useCallback(async () => {
    const folderId = await getFolderId();
    if (!folderId) {
      setBlocker("no-folder");
      return;
    }
    setBlocker("running");
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (statuses[i]?.kind === "done") continue;
      setStatus(i, { kind: "uploading", progress: 0 });
      try {
        await uploadToFolder(
          {
            uri: file.path,
            fileName: fileLabel(file, i),
            mimeType: file.mimeType,
            size: file.size,
          },
          folderId,
          (progress) => setStatus(i, { kind: "uploading", progress }),
        );
        setStatus(i, { kind: "done" });
      } catch (e) {
        if (e instanceof NotSignedInError) {
          setStatus(i, { kind: "pending" });
          setBlocker("sign-in");
          return;
        }
        setStatus(i, { kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    }
    setBlocker("finished");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length, setStatus]);

  useEffect(() => {
    if (started.current || files.length === 0) return;
    started.current = true;
    if (!getCurrentUser()) {
      setBlocker("sign-in");
      return;
    }
    runUploads();
  }, [files.length, runUploads]);

  async function handleSignIn() {
    setBusy(true);
    try {
      const user = await signIn();
      if (user) await runUploads();
    } catch (e) {
      setStatuses((prev) => prev.map(() => ({ kind: "error", message: e instanceof Error ? e.message : String(e) })));
      setBlocker("finished");
    } finally {
      setBusy(false);
    }
  }

  function finish() {
    resetShareIntent();
    router.replace("/");
  }

  const doneCount = statuses.filter((s) => s.kind === "done").length;
  const errorCount = statuses.filter((s) => s.kind === "error").length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {files.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>Nothing to upload</Text>
          <Text style={styles.body}>Sharelsen only accepts images. Share a photo to upload it.</Text>
          <Button title="Close" onPress={finish} />
        </View>
      ) : (
        <>
          <View style={styles.card}>
            {files.map((file, i) => {
              const status = statuses[i] ?? { kind: "pending" };
              const color =
                status.kind === "done" ? colors.success : status.kind === "error" ? colors.error : colors.muted;
              return (
                <View key={`${file.path}-${i}`} style={{ gap: 2 }}>
                  <Text style={styles.body} numberOfLines={1}>
                    {fileLabel(file, i)}
                  </Text>
                  <Text style={[styles.muted, { color }]}>{statusText(status)}</Text>
                </View>
              );
            })}
          </View>

          {blocker === "sign-in" ? (
            <View style={styles.card}>
              <Text style={styles.body}>Sign in with a Google account that can edit the Drive folder.</Text>
              <Button title="Sign in with Google" onPress={handleSignIn} busy={busy} />
              <Button title="Cancel" variant="secondary" onPress={finish} disabled={busy} />
            </View>
          ) : null}

          {blocker === "no-folder" ? (
            <View style={styles.card}>
              <Text style={styles.body}>No Drive folder is configured yet.</Text>
              <Button title="Open settings" onPress={finish} />
            </View>
          ) : null}

          {blocker === "finished" ? (
            <View style={styles.card}>
              <Text style={styles.body}>
                {errorCount === 0
                  ? `${doneCount === 1 ? "Photo" : `${doneCount} photos`} uploaded to Drive.`
                  : `${doneCount} uploaded, ${errorCount} failed.`}
              </Text>
              {errorCount > 0 ? <Button title="Retry failed" onPress={runUploads} /> : null}
              <Button title="Done" variant={errorCount > 0 ? "secondary" : "primary"} onPress={finish} />
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
