import { Image } from "expo-image";
import { openURL } from "expo-linking";
import { Pressable, StyleSheet, Text, View } from "react-native";

import type { DriveFile } from "@/lib/drive";
import { colors, styles } from "@/lib/theme";

type Props = {
  files: DriveFile[];
  accessToken: string;
};

function formatSize(bytes?: string): string {
  const n = Number(bytes);
  if (!bytes || Number.isNaN(n)) return "";
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

function kindLabel(mimeType?: string): string {
  if (!mimeType) return "File";
  if (mimeType === "application/vnd.google-apps.folder") return "Folder";
  if (mimeType.startsWith("image/")) return "Photo";
  if (mimeType.startsWith("video/")) return "Video";
  return mimeType.split("/").pop() ?? "File";
}

export function FileList({ files, accessToken }: Props) {
  return (
    <View style={local.list}>
      {files.map((file) => {
        const meta = [formatDate(file.createdTime), formatSize(file.size)].filter(Boolean).join(" · ");
        return (
          <Pressable
            key={file.id}
            onPress={file.webViewLink ? () => openURL(file.webViewLink!) : undefined}
            style={local.row}
          >
            {file.thumbnailLink ? (
              <Image
                source={{ uri: file.thumbnailLink, headers: { Authorization: `Bearer ${accessToken}` } }}
                style={local.thumb}
                contentFit="cover"
                transition={150}
              />
            ) : (
              <View style={[local.thumb, local.thumbPlaceholder]}>
                <Text style={local.thumbText}>{kindLabel(file.mimeType)}</Text>
              </View>
            )}
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.body} numberOfLines={1}>
                {file.name}
              </Text>
              <Text style={styles.muted}>{meta || kindLabel(file.mimeType)}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const local = StyleSheet.create({
  list: { gap: 10 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  thumb: { width: 56, height: 56, borderRadius: 8, backgroundColor: colors.background },
  thumbPlaceholder: { alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: colors.border },
  thumbText: { fontSize: 11, color: colors.muted },
});
