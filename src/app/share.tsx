import { useRouter } from "expo-router";
import { useShareIntentContext, type ShareIntentFile } from "expo-share-intent";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button } from "@/components/button";
import { folderChecksums, localMd5, uploadToFolder } from "@/lib/drive";
import { getCurrentUser, NotSignedInError, signIn } from "@/lib/google-auth";
import { getFolderId } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

type Status =
  | { kind: "pending" }
  | { kind: "checking" }
  | { kind: "uploading"; progress: number }
  | { kind: "done" }
  | { kind: "skipped"; existingName: string }
  | { kind: "error"; message: string };

type Blocker = "none" | "no-folder" | "sign-in" | "running" | "finished";

/**
 * Paths that have been uploaded (or are uploading) in this app session. Lives outside
 * React so a remount, a repeated share-intent event, or a second run of the upload loop
 * can never upload the same shared file twice. Entries are removed when the user
 * finishes the share or explicitly retries a failed file.
 */
const handledPaths = new Set<string>();

/** True while an upload loop is running anywhere in the app, across remounts. */
let uploadLoopRunning = false;

const log = (...args: unknown[]) => console.log("[sharelsen]", ...args);

const VARIANT = {
  original: /(^|[/_.\-])ORIGINAL([/_.\-]|$)/,
  cover: /(^|[/_.\-])COVER([/_.\-]|$)/,
};

function matchesVariant(file: ShareIntentFile, pattern: RegExp): boolean {
  return [file.contentUri, file.path, file.fileName].some((v) => (v ? pattern.test(decodeURIComponent(v)) : false));
}

/**
 * Google Photos sometimes shares two variants of one picture, tagged COVER and ORIGINAL in
 * their content URIs. When both kinds are present, keep only the ORIGINAL ones.
 */
function dropCoverVariants(files: ShareIntentFile[]): ShareIntentFile[] {
  const hasOriginal = files.some((f) => matchesVariant(f, VARIANT.original));
  if (!hasOriginal) return files;
  return files.filter((f) => !matchesVariant(f, VARIANT.cover));
}

function isMedia(file: ShareIntentFile): boolean {
  return Boolean(file.mimeType?.startsWith("image/") || file.mimeType?.startsWith("video/"));
}

function fileLabel(file: ShareIntentFile, index: number): string {
  return file.fileName || `${file.mimeType?.startsWith("video/") ? "Video" : "Photo"} ${index + 1}`;
}

function statusText(status: Status): string {
  switch (status.kind) {
    case "pending":
      return "Waiting";
    case "checking":
      return "Checking for duplicates…";
    case "uploading":
      return `Uploading ${Math.round(status.progress * 100)}%`;
    case "done":
      return "Uploaded";
    case "skipped":
      return `Already in folder as "${status.existingName}"`;
    case "error":
      return status.message;
  }
}

export default function Share() {
  const router = useRouter();
  const { shareIntent, resetShareIntent, error: shareError } = useShareIntentContext();

  const files = useMemo(() => {
    const media = (shareIntent.files ?? []).filter(isMedia);
    const kept = dropCoverVariants(media);
    if (kept.length !== media.length) {
      log(`dropped ${media.length - kept.length} COVER variant(s), keeping ORIGINAL`);
    }
    return kept;
  }, [shareIntent.files]);
  // Stable identity for "which share is this": changes only when the set of files changes.
  const signature = files.map((f) => f.path).join("|");

  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const [blocker, setBlocker] = useState<Blocker>("none");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    log(
      "share screen mounted; files:",
      files.map((f) => `${f.fileName} ${f.size ?? "?"}B path=${f.path} uri=${f.contentUri ?? "-"}`),
    );
    return () => log("share screen unmounted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatus = useCallback((path: string, status: Status) => {
    setStatuses((prev) => (prev[path]?.kind === status.kind && status.kind !== "uploading" ? prev : { ...prev, [path]: status }));
  }, []);

  /**
   * Uploads every file in `targets` that hasn't been handled yet. Safe to call repeatedly:
   * a concurrent run is skipped, and already-handled paths are ignored.
   */
  const runUploads = useCallback(
    async (targets: ShareIntentFile[]) => {
      if (uploadLoopRunning) {
        log("upload loop already running, ignoring start request");
        return;
      }
      uploadLoopRunning = true;
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
        log(`starting uploads: ${todo.length} of ${targets.length} file(s) not yet handled`);
        const existing = await folderChecksums(folderId);
        log(`folder has ${existing.size} file(s) with checksums`);
        for (const file of todo) {
          if (handledPaths.has(file.path)) continue;
          handledPaths.add(file.path);
          setStatus(file.path, { kind: "checking" });
          try {
            const md5 = await localMd5(file.path);
            setStatus(file.path, { kind: "uploading", progress: 0 });
            const duplicateOf = existing.get(md5);
            if (duplicateOf) {
              log(`skip ${file.fileName}: identical to "${duplicateOf}" already in folder (md5 ${md5})`);
              setStatus(file.path, { kind: "skipped", existingName: duplicateOf });
              continue;
            }
            log(`upload ${file.fileName} (md5 ${md5}) from ${file.path}`);
            const uploaded = await uploadToFolder(
              {
                uri: file.path,
                fileName: fileLabel(file, targets.indexOf(file)),
                mimeType: file.mimeType,
                size: file.size,
              },
              folderId,
              (progress) => setStatus(file.path, { kind: "uploading", progress }),
            );
            existing.set(md5, uploaded.name);
            log(`uploaded ${file.fileName} → Drive id ${uploaded.id}`);
            setStatus(file.path, { kind: "done" });
          } catch (e) {
            log(`failed ${file.fileName}:`, e instanceof Error ? e.message : e);
            handledPaths.delete(file.path);
            if (e instanceof NotSignedInError) {
              setStatus(file.path, { kind: "pending" });
              setBlocker("sign-in");
              return;
            }
            setStatus(file.path, { kind: "error", message: e instanceof Error ? e.message : String(e) });
          }
        }
        log("upload loop finished");
        setBlocker("finished");
      } finally {
        uploadLoopRunning = false;
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
  const skippedCount = files.filter((f) => statusOf(f).kind === "skipped").length;
  const errorCount = files.filter((f) => statusOf(f).kind === "error").length;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      {files.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>Nothing to upload</Text>
          <Text style={styles.body}>Sharelsen only accepts photos and videos. Share one to upload it.</Text>
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
                {[
                  `${doneCount} uploaded`,
                  skippedCount ? `${skippedCount} already in folder` : null,
                  errorCount ? `${errorCount} failed` : null,
                ]
                  .filter(Boolean)
                  .join(", ") + "."}
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
