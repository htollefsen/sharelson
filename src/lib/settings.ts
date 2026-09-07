import Constants from "expo-constants";
import * as SecureStore from "expo-secure-store";

const FOLDER_KEY = "driveFolderId";

/**
 * Accepts either a bare Drive folder ID or a Drive folder URL such as
 * https://drive.google.com/drive/folders/<id> or
 * https://drive.google.com/drive/u/0/folders/<id>?usp=sharing
 * and returns the folder ID, or null if the input doesn't look like one.
 */
export function parseFolderId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/folders\/([A-Za-z0-9_-]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

/** Folder baked into the build (app.json → extra.defaultDriveFolderId), used until the user saves another. */
export function getDefaultFolderId(): string | null {
  const id = Constants.expoConfig?.extra?.defaultDriveFolderId as string | undefined;
  return id ? parseFolderId(id) : null;
}

/** The user's saved folder, falling back to the build default. */
export async function getFolderId(): Promise<string | null> {
  return (await SecureStore.getItemAsync(FOLDER_KEY)) ?? getDefaultFolderId();
}

export async function setFolderId(id: string): Promise<void> {
  await SecureStore.setItemAsync(FOLDER_KEY, id);
}

export async function clearFolderId(): Promise<void> {
  await SecureStore.deleteItemAsync(FOLDER_KEY);
}
