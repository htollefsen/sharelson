# Sharelsen

Android-only React Native app built with Expo SDK 57 and TypeScript. Distributed
manually as a sideloaded APK to a few family members. No Google Play, no iOS, no web.

Read the versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing code.

## Layout

- `src/app/` — expo-router file-based routes. `_layout.tsx` is the root Stack.
- `assets/images/` — icon, adaptive icon layers, splash icon.
- `app.json` — Expo config. Android package id is `no.tollefsen.sharelsen`.
- `eas.json` — EAS Build config. The `apk` profile produces an installable APK.

## Commands

- `npm start` — Metro dev server; scan the QR code with Expo Go on the phone.
- `npm run android` — same, but tries to launch on a connected device via adb.
- `npm run typecheck` — `tsc --noEmit`.
- `npm run lint` — `expo lint`.
- `npm run build:apk` — cloud APK build via EAS (requires `npx eas login` once).

## Conventions

- Android only: don't add iOS or web config, platform files, or dependencies.
- Bump `expo.android.versionCode` in `app.json` for every APK handed out.
- Use Expo SDK libraries (`expo-*`) over bare community packages when one exists.
