import * as SecureStore from "expo-secure-store";

const FOLDER_ID_KEY = "driveFolderId";
const FOLDER_NAME_KEY = "driveFolderName";

export type SavedFolder = { id: string; name: string };

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

/** The folder chosen during setup, or null when setup hasn't been completed. */
export async function getFolder(): Promise<SavedFolder | null> {
  const id = await SecureStore.getItemAsync(FOLDER_ID_KEY);
  if (!id) return null;
  const name = (await SecureStore.getItemAsync(FOLDER_NAME_KEY)) ?? "Drive folder";
  return { id, name };
}

export async function getFolderId(): Promise<string | null> {
  return SecureStore.getItemAsync(FOLDER_ID_KEY);
}

export async function setFolder(folder: SavedFolder): Promise<void> {
  await SecureStore.setItemAsync(FOLDER_ID_KEY, folder.id);
  await SecureStore.setItemAsync(FOLDER_NAME_KEY, folder.name);
}

/** Forgets everything the app has stored, so the setup wizard runs again. */
export async function clearSettings(): Promise<void> {
  await SecureStore.deleteItemAsync(FOLDER_ID_KEY);
  await SecureStore.deleteItemAsync(FOLDER_NAME_KEY);
}
