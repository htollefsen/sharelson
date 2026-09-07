import { useRouter } from "expo-router";
import { useShareIntentContext, type ShareIntentFile } from "expo-share-intent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type Blocker = "none" | "no-folder" | "sign-in" | "running" | "finished";

/**
 * Paths that have been uploaded (or are uploading) in this app session. Lives outside
 * React so a remount, a repeated share-intent event, or a second run of the upload loop
 * can never upload the same shared file twice. Entries are removed when the user
 * finishes the share or explicitly retries a failed file.
 */
const handledPaths = new Set<string>();

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
  const { shareIntent, resetShareIntent, error: shareError } = useShareIntentContext();

  const files = useMemo(
    () => (shareIntent.files ?? []).filter((f) => f.mimeType?.startsWith("image/")),
    [shareIntent.files],
  );
  // Stable identity for "which share is this": changes only when the set of files changes.
  const signature = files.map((f) => f.path).join("|");

  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [blocker, setBlocker] = useState<Blocker>("none");
  const [busy, setBusy] = useState(false);
  const running = useRef(false);

  const setStatus = useCallback((path: string, status: Status) => {
    setStatuses((prev) => (prev[path]?.kind === status.kind && status.kind !== "uploading" ? prev : { ...prev, [path]: status }));
  }, []);

  /**
   * Uploads every file in `targets` that hasn't been handled yet. Safe to call repeatedly:
   * a concurrent run is skipped, and already-handled paths are ignored.
   */
  const runUploads = useCallback(
    async (targets: ShareIntentFile[]) => {
      if (running.current) return;
      running.current = true;
      try {
        // Nothing below runs synchronously with the caller, so React state updates are safe
        // even when this is invoked from an effect.
        const folderId = await getFolderId();
        const todo = targets.filter((f) => !handledPaths.has(f.path));
        if (todo.length === 0) {
          setBlocker("finished");
          return;
        }
        if (!folderId) {
          setBlocker("no-folder");
          return;
        }
        if (!getCurrentUser()) {
          setBlocker("sign-in");
          return;
        }
        setBlocker("running");
        for (const file of todo) {
          if (handledPaths.has(file.path)) continue;
          handledPaths.add(file.path);
          setStatus(file.path, { kind: "uploading", progress: 0 });
          try {
            await uploadToFolder(
              {
                uri: file.path,
                fileName: fileLabel(file, targets.indexOf(file)),
                mimeType: file.mimeType,
                size: file.size,
              },
              folderId,
              (progress) => setStatus(file.path, { kind: "uploading", progress }),
            );
            setStatus(file.path, { kind: "done" });
          } catch (e) {
            handledPaths.delete(file.path);
            if (e instanceof NotSignedInError) {
              setStatus(file.path, { kind: "pending" });
              setBlocker("sign-in");
              return;
            }
            setStatus(file.path, { kind: "error", message: e instanceof Error ? e.message : String(e) });
          }
        }
        setBlocker("finished");
      } finally {
        running.current = false;
      }
    },
    [setStatus],
  );

  // Start (or continue) uploading whenever a share arrives. Keyed on the file signature so a
  // new share while this screen is open is picked up, while re-renders and duplicate
  // share-intent events with the same files are no-ops thanks to handledPaths.
  useEffect(() => {
    if (files.length === 0) return;
    void runUploads(files);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, runUploads]);

  async function handleSignIn() {
    setBusy(true);
    try {
      const user = await signIn();
      if (user) await runUploads(files);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatuses((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, { kind: "error", message }])));
      setBlocker("finished");
    } finally {
      setBusy(false);
    }
  }

  function retryFailed() {
    for (const f of files) {
      if (statuses[f.path]?.kind === "error") handledPaths.delete(f.path);
    }
    runUploads(files);
  }

  function finish() {
    for (const f of files) handledPaths.delete(f.path);
    resetShareIntent();
    router.replace("/");
  }

  const statusOf = (file: ShareIntentFile): Status => statuses[file.path] ?? { kind: "pending" };
  const doneCount = files.filter((f) => statusOf(f).kind === "done").length;
  const errorCount = files.filter((f) => statusOf(f).kind === "error").length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {files.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>Nothing to upload</Text>
          <Text style={styles.body}>Sharelsen only accepts images. Share a photo to upload it.</Text>
          {shareError ? <Text style={[styles.muted, { color: colors.error }]}>{shareError}</Text> : null}
          <Button title="Close" onPress={finish} />
        </View>
      ) : (
        <>
          <View style={styles.card}>
            {files.map((file, i) => {
              const status = statusOf(file);
              const color =
                status.kind === "done" ? colors.success : status.kind === "error" ? colors.error : colors.muted;
              return (
                <View key={file.path} style={{ gap: 2 }}>
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
              {errorCount > 0 ? <Button title="Retry failed" onPress={retryFailed} /> : null}
              <Button title="Done" variant={errorCount > 0 ? "secondary" : "primary"} onPress={finish} />
            </View>
          ) : null}
        </>
      )}
    </ScrollView>
  );
}
