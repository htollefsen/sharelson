import { File, UploadType } from "expo-file-system";
import { getInfoAsync } from "expo-file-system/legacy";
import SparkMD5 from "spark-md5";

import { getAccessToken, invalidateAccessToken } from "./google-auth";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

export type DriveFile = {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  createdTime?: string;
  thumbnailLink?: string;
  webViewLink?: string;
  md5Checksum?: string;
};

export type FolderListing = {
  files: DriveFile[];
  /** Token to send as Authorization for thumbnailLink requests, valid for about an hour. */
  accessToken: string;
};

export type UploadInput = {
  /** file:// or content:// URI, or a bare filesystem path. */
  uri: string;
  fileName: string;
  mimeType: string;
  size: number | null;
  /** When the content was originally created; stored as Drive's createdTime/modifiedTime. */
  createdAt?: Date | null;
};

export class DriveError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DriveError";
  }
}

export function toFileUri(uri: string): string {
  return /^[a-z]+:\/\//i.test(uri) ? uri : `file://${uri}`;
}

async function describeError(response: Response, fallback: string): Promise<DriveError> {
  let message = fallback;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // ignore: body wasn't JSON
  }
  if (response.status === 404) {
    message = "Folder not found, or this Google account has no access to it";
  }
  return new DriveError(message, response.status);
}

/**
 * Runs `request` with a fresh access token, retrying once with a renewed token
 * if Google answers 401.
 */
async function withToken<T>(request: (token: string) => Promise<T & { status: number }>): Promise<T> {
  let token = await getAccessToken();
  let result = await request(token);
  if (result.status === 401) {
    await invalidateAccessToken(token);
    token = await getAccessToken();
    result = await request(token);
  }
  return result;
}

/** Looks up a folder by ID so the user can confirm they pasted the right one. */
export async function getFolder(folderId: string): Promise<DriveFile> {
  const response = await withToken((token) =>
    fetch(`${DRIVE_API}/files/${encodeURIComponent(folderId)}?fields=id,name,mimeType&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  );
  if (!response.ok) throw await describeError(response, "Could not read folder");
  const folder = (await response.json()) as DriveFile;
  if (folder.mimeType !== "application/vnd.google-apps.folder") {
    throw new DriveError("That ID is a file, not a folder", 400);
  }
  return folder;
}

const LIST_FIELDS = "files(id,name,mimeType,size,createdTime,thumbnailLink,webViewLink)";

/** Lists the folder's contents, newest first. Only the first page (up to `pageSize` items). */
export async function listFolder(folderId: string, pageSize = 100): Promise<FolderListing> {
  let usedToken = "";
  const params = new URLSearchParams({
    q: `'${folderId}' in parents and trashed=false`,
    orderBy: "createdTime desc",
    pageSize: String(pageSize),
    fields: LIST_FIELDS,
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  const response = await withToken((token) => {
    usedToken = token;
    return fetch(`${DRIVE_API}/files?${params}`, { headers: { Authorization: `Bearer ${token}` } });
  });
  if (!response.ok) throw await describeError(response, "Could not list folder");
  const body = (await response.json()) as { files?: DriveFile[] };
  return { files: body.files ?? [], accessToken: usedToken };
}

/**
 * MD5 of a local file, hex, matching Drive's `md5Checksum` field. Hashed natively when the
 * platform supports it (fast, constant memory, fine for large videos); otherwise streamed
 * through a JS implementation in chunks so the whole file is never held in memory.
 */
export async function localMd5(uri: string): Promise<string> {
  const fileUri = toFileUri(uri);
  try {
    const info = await getInfoAsync(fileUri, { md5: true });
    if (info.exists && info.md5) return info.md5;
  } catch {
    // fall through to the streaming implementation
  }
  const hasher = new SparkMD5.ArrayBuffer();
  const reader = new File(fileUri).readableStream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    hasher.append(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer);
  }
  return hasher.end();
}

/**
 * Every MD5 checksum currently in the folder, mapped to the file's name. Pages through the
 * whole folder so the result is complete even for large folders.
 */
export async function folderChecksums(folderId: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      pageSize: "1000",
      fields: "nextPageToken,files(name,md5Checksum)",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await withToken((token) =>
      fetch(`${DRIVE_API}/files?${params}`, { headers: { Authorization: `Bearer ${token}` } }),
    );
    if (!response.ok) throw await describeError(response, "Could not read folder contents");
    const body = (await response.json()) as { files?: DriveFile[]; nextPageToken?: string };
    for (const f of body.files ?? []) if (f.md5Checksum) result.set(f.md5Checksum, f.name);
    pageToken = body.nextPageToken;
  } while (pageToken);
  return result;
}

/**
 * Uploads one file into `folderId` using Drive's resumable upload protocol:
 * first a small JSON request creates the session and returns a Location URL,
 * then the file bytes are streamed to that URL straight from disk.
 */
export async function uploadToFolder(
  input: UploadInput,
  folderId: string,
  onProgress?: (fraction: number) => void,
): Promise<DriveFile> {
  const file = new File(toFileUri(input.uri));
  const size = input.size ?? file.size;
  const mimeType = input.mimeType || file.type || "application/octet-stream";

  const session = await withToken((token) =>
    fetch(`${DRIVE_UPLOAD}?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,createdTime,modifiedTime`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": mimeType,
        ...(size != null ? { "X-Upload-Content-Length": String(size) } : {}),
      },
      body: JSON.stringify({
        name: input.fileName,
        parents: [folderId],
        ...(input.createdAt
          ? { createdTime: input.createdAt.toISOString(), modifiedTime: input.createdAt.toISOString() }
          : {}),
      }),
    }),
  );
  if (!session.ok) throw await describeError(session, "Could not start upload");

  const location = session.headers.get("location");
  if (!location) throw new DriveError("Drive did not return an upload URL", session.status);

  const result = await file.upload(location, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    mimeType,
    headers: { "Content-Type": mimeType },
    onProgress: onProgress
      ? ({ bytesSent, totalBytes }) => {
          if (totalBytes > 0) onProgress(bytesSent / totalBytes);
        }
      : undefined,
  });

  if (result.status < 200 || result.status >= 300) {
    let message = `Upload failed with status ${result.status}`;
    try {
      const body = JSON.parse(result.body) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // ignore
    }
    throw new DriveError(message, result.status);
  }
  return JSON.parse(result.body) as DriveFile;
}
