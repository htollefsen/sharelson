import {
  GoogleSignin,
  isNoSavedCredentialFoundResponse,
  isSuccessResponse,
  type User,
} from "@react-native-google-signin/google-signin";
import Constants from "expo-constants";

/**
 * Full Drive scope is needed because the target folder is not created by this
 * app. The narrower `drive.file` scope only allows access to files and folders
 * the app itself created.
 */
const SCOPES = ["https://www.googleapis.com/auth/drive"];

export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to Google");
    this.name = "NotSignedInError";
  }
}

let configured = false;

export function configureGoogle(): void {
  if (configured) return;
  const webClientId = Constants.expoConfig?.extra?.googleWebClientId as
    | string
    | undefined;
  GoogleSignin.configure({
    scopes: SCOPES,
    webClientId: webClientId || undefined,
  });
  configured = true;
}

export function getCurrentUser(): User | null {
  return GoogleSignin.getCurrentUser();
}

/** Interactive sign-in. Resolves with the user, or null if the user cancelled. */
export async function signIn(): Promise<User | null> {
  configureGoogle();
  await GoogleSignin.hasPlayServices();
  const response = await GoogleSignin.signIn();
  return isSuccessResponse(response) ? response.data : null;
}

export async function signOut(): Promise<void> {
  await GoogleSignin.signOut();
}

/**
 * Returns a valid access token, signing in silently if the native SDK has a
 * saved account. Throws NotSignedInError if interactive sign-in is required.
 */
export async function getAccessToken(): Promise<string> {
  configureGoogle();
  if (!GoogleSignin.getCurrentUser()) {
    const response = await GoogleSignin.signInSilently();
    if (isNoSavedCredentialFoundResponse(response)) {
      throw new NotSignedInError();
    }
  }
  const { accessToken } = await GoogleSignin.getTokens();
  return accessToken;
}

/** Drop a token the API rejected so the next getAccessToken() fetches a fresh one. */
export async function invalidateAccessToken(token: string): Promise<void> {
  await GoogleSignin.clearCachedAccessToken(token);
}
