# Sharelsen

Share a photo from any Android app to Sharelsen and it lands in a private Google Drive
folder. Android only, distributed as a sideloaded APK to family.

## How it works

1. Each family member installs the APK and signs in with their own Google account.
2. They paste the link to the shared Drive folder once, on the settings screen.
3. From then on, sharing a photo to Sharelsen uploads it straight into that folder.

The Drive folder owner shares the folder (as Editor) with each family member's Google account.
Uploads are made by each person's own account, so nothing about the owner's account is stored
in the app.

## One-time Google Cloud setup (folder owner)

1. Create a project at https://console.cloud.google.com/ and enable the **Google Drive API**.
2. Under **APIs & Services → OAuth consent screen**:
   - User type: External. Publishing status: **Testing**.
   - Add every family member's Gmail address as a **test user**.
   - Add the scope `https://www.googleapis.com/auth/drive`.
3. Under **Credentials**, create an OAuth client ID of type **Android**:
   - Package name: `no.tollefsen.sharelsen`
   - SHA-1: the fingerprint of the EAS-managed signing key. Current value:
     `39:7E:BD:9E:19:14:FA:54:C5:85:CF:4D:09:D3:3A:A3:33:60:9D:4E`
     (re-read it with `npm run eas -- credentials` if the keystore is ever regenerated).
4. Optionally create a **Web application** client ID and put its ID in `app.json` under
   `expo.extra.googleWebClientId`. It is not needed for uploads, only if ID tokens are ever
   required.

## Development

```bash
npm install
npm run build:dev     # one-time: cloud build of a development APK, install it on the phone
npm start             # then open the dev build on the phone
npm run typecheck
npm run lint
```

Expo Go does not work for this app because share intents and Google Sign-In are native
modules. The development build replaces Expo Go and reloads code from `npm start` as usual.

## Releasing an APK

1. Optionally bump `expo.version` in `app.json`. The Android version code is managed by EAS and
   increments automatically for every release build.
2. `npm run build:apk`
3. Download the APK from the EAS build page and send it to the family.
