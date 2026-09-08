import { useRouter } from "expo-router";
import { useShareIntentContext, type ShareIntentFile } from "expo-share-intent";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";

import { Button } from "@/components/button";
import { PageRenderer, type PageRendererHandle } from "@/components/page-renderer";
import { folderChecksums, localMd5, uploadToFolder, type UploadInput } from "@/lib/drive";
import { getCurrentUser, NotSignedInError, signIn } from "@/lib/google-auth";
import { buildOfflinePage, fetchLink, saveOfflinePage } from "@/lib/offline-page";
import { getFolderId } from "@/lib/settings";
import { colors, styles } from "@/lib/theme";

/** One thing to upload: a shared photo, video or PDF, or a link (web page or direct file). */
type ShareItem =
  | { key: string; kind: "media"; file: ShareIntentFile; label: string }
  | { key: string; kind: "page"; url: string; label: string };

type Status =
  | { kind: "pending" }
  | { kind: "downloading"; detail?: string }
  | { kind: "checking" }
  | { kind: "uploading"; progress: number }
  | { kind: "done"; name?: string }
  | { kind: "skipped"; existingName: string }
  | { kind: "error"; message: string };

type Blocker = "none" | "no-folder" | "sign-in" | "running" | "finished";

/**
 * Keys (file paths or page URLs) handled in this app session. Lives outside React so a remount,
 * a repeated share-intent event, or a second run of the upload loop can never upload the same
 * thing twice. Entries are removed when the user finishes or explicitly retries a failure.
 */
const handledKeys = new Set<string>();

/** True while an upload loop is running anywhere in the app, across remounts. */
let uploadLoopRunning = false;

const log = (...args: unknown[]) => console.log("[sharelsen]", ...args);

/**
 * Google Photos can share two variants of one picture, e.g. Pixel RAW+JPEG pairs named
 * `PXL_<time>.RAW-01.MP.COVER.jpg` and `PXL_<time>.RAW-02.ORIGINAL.dng`. Only the file name
 * is inspected: the content URI must not be used because every Google Photos URI contains a
 * `REQUIRE_ORIGINAL` segment, which would make a lone COVER file look like a duplicate.
 */
const VARIANT = {
  original: /\.ORIGINAL\./i,
  cover: /\.COVER\./i,
};

function baseName(file: ShareIntentFile): string {
  const name = file.fileName || decodeURIComponent(file.path ?? "");
  return name.slice(name.lastIndexOf("/") + 1);
}

/** The part of the name that both variants of a picture share, e.g. `PXL_20260908_155528502`. */
function stem(name: string): string {
  return name.split(".")[0];
}

/**
 * When a COVER variant is shared together with the ORIGINAL variant of the same picture, keep
 * only the ORIGINAL. A COVER file on its own is uploaded as is.
 */
function dropCoverVariants(files: ShareIntentFile[]): ShareIntentFile[] {
  const originals = new Set(
    files
      .map(baseName)
      .filter((n) => VARIANT.original.test(n))
      .map(stem),
  );
  if (originals.size === 0) return files;
  return files.filter((f) => {
    const name = baseName(f);
    return !(VARIANT.cover.test(name) && originals.has(stem(name)));
  });
}

const PDF = "application/pdf";

function isMedia(file: ShareIntentFile): boolean {
  const type = file.mimeType ?? "";
  return type.startsWith("image/") || type.startsWith("video/") || type === PDF;
}

function mediaLabel(file: ShareIntentFile, index: number): string {
  if (file.fileName) return file.fileName;
  const type = file.mimeType ?? "";
  const kind = type === PDF ? "PDF" : type.startsWith("video/") ? "Video" : "Photo";
  return `${kind} ${index + 1}`;
}

function statusText(status: Status): string {
  switch (status.kind) {
    case "pending":
      return "Waiting";
    case "downloading":
      if (status.detail === "file") return "Downloading…";
      if (status.detail === "render") return "Loading page…";
      return status.detail ? `Saving page… ${status.detail}` : "Saving page…";
    case "checking":
      return "Checking for duplicates…";
    case "uploading":
      return `Uploading ${Math.round(status.progress * 100)}%`;
    case "done":
      return status.name ? `Uploaded as "${status.name}"` : "Uploaded";
    case "skipped":
      return `Already in folder as "${status.existingName}"`;
    case "error":
      return status.message;
  }
}

export default function Share() {
  const router = useRouter();
  const { shareIntent, resetShareIntent, error: shareError } = useShareIntentContext();

  const items = useMemo<ShareItem[]>(() => {
    const media = (shareIntent.files ?? []).filter(isMedia);
    const kept = dropCoverVariants(media);
    if (kept.length !== media.length) {
      log(`dropped ${media.length - kept.length} COVER variant(s), keeping ORIGINAL`);
    }
    const list: ShareItem[] = kept.map((file, i) => ({
      key: file.path,
      kind: "media",
      file,
      label: mediaLabel(file, i),
    }));
    if (shareIntent.webUrl) {
      list.push({
        key: shareIntent.webUrl,
        kind: "page",
        url: shareIntent.webUrl,
        label: shareIntent.meta?.title || shareIntent.webUrl,
      });
    }
    return list;
  }, [shareIntent.files, shareIntent.webUrl, shareIntent.meta?.title]);

  // Stable identity for "which share is this": changes only when the set of items changes.
  const signature = items.map((i) => i.key).join("|");

  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  const renderer = useRef<PageRendererHandle>(null);
  const [blocker, setBlocker] = useState<Blocker>("none");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    log(
      "share screen mounted; items:",
      items.map((i) =>
        i.kind === "media"
          ? `${i.file.fileName} ${i.file.size ?? "?"}B path=${i.file.path} uri=${i.file.contentUri ?? "-"}`
          : `page ${i.url}`,
      ),
    );
    return () => log("share screen unmounted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setStatus = useCallback((key: string, status: Status) => {
    setStatuses((prev) => ({ ...prev, [key]: status }));
  }, []);

  /** Uploads a shared photo, video or PDF. Returns the Drive file name, or the duplicate's name. */
  const uploadMedia = useCallback(
    async (item: Extract<ShareItem, { kind: "media" }>, folderId: string, existing: Map<string, string>) => {
      setStatus(item.key, { kind: "checking" });
      const md5 = await localMd5(item.file.path);
      const duplicateOf = existing.get(md5);
      if (duplicateOf) {
        log(`skip ${item.label}: identical to "${duplicateOf}" already in folder (md5 ${md5})`);
        setStatus(item.key, { kind: "skipped", existingName: duplicateOf });
        return;
      }
      setStatus(item.key, { kind: "uploading", progress: 0 });
      log(`upload ${item.label} (md5 ${md5}) from ${item.file.path}`);
      const uploaded = await uploadToFolder(
        {
          uri: item.file.path,
          fileName: item.label,
          mimeType: item.file.mimeType,
          size: item.file.size,
        },
        folderId,
        (progress) => setStatus(item.key, { kind: "uploading", progress }),
      );
      existing.set(md5, uploaded.name);
      log(`uploaded ${item.label} → Drive id ${uploaded.id}`);
      setStatus(item.key, { kind: "done" });
    },
    [setStatus],
  );

  /**
   * Downloads a shared link and uploads it: a link to a PDF, image or video is uploaded as that
   * file. A web page is rendered in a hidden WebView so its JavaScript runs (falling back to the
   * server's HTML if that fails), then saved as a self-contained HTML file.
   */
  const uploadPage = useCallback(
    async (item: Extract<ShareItem, { kind: "page" }>, folderId: string, existing: Map<string, string>) => {
      setStatus(item.key, { kind: "downloading" });
      log(`saving link ${item.url}`);
      const onProgress = (p: { stage: string; done?: number; total?: number }) => {
        if (p.stage === "file") setStatus(item.key, { kind: "downloading", detail: "file" });
        if (p.stage === "assets" && p.total)
          setStatus(item.key, {
            kind: "downloading",
            detail: `${p.done}/${p.total} assets`,
          });
      };
      const fetched = await fetchLink(item.url, onProgress);
      let upload: UploadInput;
      if (fetched.kind === "html") {
        let html = fetched.html;
        let finalUrl = fetched.finalUrl;
        setStatus(item.key, { kind: "downloading", detail: "render" });
        try {
          const rendered = await renderer.current!.render(fetched.finalUrl);
          log(`rendered page "${rendered.title}" ${rendered.html.length} chars at ${rendered.finalUrl}`);
          html = rendered.html;
          finalUrl = rendered.finalUrl;
        } catch (e) {
          log("render failed, using server HTML:", e instanceof Error ? e.message : e);
        }
        const page = await buildOfflinePage(html, item.url, finalUrl, onProgress);
        log(
          `page built: "${page.title}" ${page.html.length} chars, ${page.inlinedAssets} assets inlined, ${page.skippedAssets} skipped`,
        );
        upload = { uri: saveOfflinePage(page), fileName: page.fileName, mimeType: "text/html", size: null };
      } else {
        log(`downloaded file "${fetched.fileName}" ${fetched.size}B (${fetched.mimeType}) from ${fetched.finalUrl}`);
        upload = { uri: fetched.uri, fileName: fetched.fileName, mimeType: fetched.mimeType, size: fetched.size };
      }
      setStatus(item.key, { kind: "checking" });
      const md5 = await localMd5(upload.uri);
      const duplicateOf = existing.get(md5);
      if (duplicateOf) {
        setStatus(item.key, { kind: "skipped", existingName: duplicateOf });
        return;
      }
      setStatus(item.key, { kind: "uploading", progress: 0 });
      const uploaded = await uploadToFolder(upload, folderId, (progress) =>
        setStatus(item.key, { kind: "uploading", progress }),
      );
      existing.set(md5, uploaded.name);
      log(`uploaded page → Drive id ${uploaded.id}`);
      setStatus(item.key, { kind: "done", name: uploaded.name });
    },
    [setStatus],
  );

  /**
   * Uploads every item in `targets` that hasn't been handled yet. Safe to call repeatedly:
   * a concurrent run is skipped, and already-handled keys are ignored.
   */
  const runUploads = useCallback(
    async (targets: ShareItem[]) => {
      if (uploadLoopRunning) {
        log("upload loop already running, ignoring start request");
        return;
      }
      uploadLoopRunning = true;
      try {
        // Nothing below runs synchronously with the caller, so React state updates are safe
        // even when this is invoked from an effect.
        const folderId = await getFolderId();
        const todo = targets.filter((t) => !handledKeys.has(t.key));
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
        log(`starting uploads: ${todo.length} of ${targets.length} item(s) not yet handled`);
        const existing = await folderChecksums(folderId);
        log(`folder has ${existing.size} file(s) with checksums`);
        for (const item of todo) {
          if (handledKeys.has(item.key)) continue;
          handledKeys.add(item.key);
          try {
            if (item.kind === "media") await uploadMedia(item, folderId, existing);
            else await uploadPage(item, folderId, existing);
          } catch (e) {
            log(`failed ${item.label}:`, e instanceof Error ? e.message : e);
            handledKeys.delete(item.key);
            if (e instanceof NotSignedInError) {
              setStatus(item.key, { kind: "pending" });
              setBlocker("sign-in");
              return;
            }
            setStatus(item.key, {
              kind: "error",
              message: e instanceof Error ? e.message : String(e),
            });
          }
        }
        log("upload loop finished");
        setBlocker("finished");
      } finally {
        uploadLoopRunning = false;
      }
    },
    [setStatus, uploadMedia, uploadPage],
  );

  // Start (or continue) uploading whenever a share arrives. Keyed on the signature so a new
  // share while this screen is open is picked up, while re-renders and duplicate share-intent
  // events with the same content are no-ops thanks to handledKeys.
  useEffect(() => {
    if (items.length === 0) return;
    void runUploads(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, runUploads]);

  async function handleSignIn() {
    setBusy(true);
    try {
      const user = await signIn();
      if (user) await runUploads(items);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setStatuses((prev) => Object.fromEntries(Object.keys(prev).map((k) => [k, { kind: "error", message }])));
      setBlocker("finished");
    } finally {
      setBusy(false);
    }
  }

  function retryFailed() {
    for (const item of items) {
      if (statuses[item.key]?.kind === "error") handledKeys.delete(item.key);
    }
    void runUploads(items);
  }

  function finish() {
    for (const item of items) handledKeys.delete(item.key);
    resetShareIntent();
    router.replace("/");
  }

  const statusOf = (item: ShareItem): Status => statuses[item.key] ?? { kind: "pending" };
  const count = (kind: Status["kind"]) => items.filter((i) => statusOf(i).kind === kind).length;
  const doneCount = count("done");
  const skippedCount = count("skipped");
  const errorCount = count("error");

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <PageRenderer ref={renderer} />
      {items.length === 0 ? (
        <View style={styles.card}>
          <Text style={styles.title}>Nothing to upload</Text>
          <Text style={styles.body}>Sharelsen accepts photos, videos, PDFs, and links to web pages.</Text>
          {shareIntent.text ? (
            <Text style={styles.muted} numberOfLines={3}>
              Shared text: {shareIntent.text}
            </Text>
          ) : null}
          {shareError ? <Text style={[styles.muted, { color: colors.error }]}>{shareError}</Text> : null}
          <Button title="Close" onPress={finish} />
        </View>
      ) : (
        <>
          <View style={styles.card}>
            {items.map((item) => {
              const status = statusOf(item);
              const color =
                status.kind === "done" ? colors.success : status.kind === "error" ? colors.error : colors.muted;
              return (
                <View key={item.key} style={{ gap: 2 }}>
                  <Text style={styles.body} numberOfLines={1}>
                    {item.kind === "page" ? "Link: " : ""}
                    {item.label}
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
