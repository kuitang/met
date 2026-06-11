# Mobile preview builds (EAS)

EAS project: `@kuitang/met-navigator` (projectId `2503719e-2d3a-4698-abc7-9c56bf51eaf1`,
https://expo.dev/accounts/kuitang/projects/met-navigator). Auth: `export EXPO_TOKEN=$(cat ~/expo_key.txt)`.

Profiles live in `apps/mobile/eas.json`. The `preview` profile builds an internal-distribution
Android APK with `EXPO_PUBLIC_API_URL=https://musewalk.app` and `EXPO_PUBLIC_DATA=real`
baked in — the APK talks to the prod Fly server and uses the real SQLite data provider.

## Android

```sh
cd apps/mobile
npx eas-cli build --profile preview --platform android --non-interactive --no-wait
```

Android keystore is stored remotely on EAS (generated 2026-06-10; first generation required an
interactive run — `--non-interactive` fails with "Generating a new Keystore is not supported in
--non-interactive mode" until the keystore exists). Install the APK from the build page or
`npx eas-cli build:list --platform android --limit 1` for the artifact URL.

## iOS — no EAS build yet (no Apple Developer credentials)

`eas build --profile preview --platform ios --non-interactive` fails with:

```
✔ Using remote iOS credentials (Expo server)

Failed to set up credentials.
You're in non-interactive mode. EAS CLI couldn't find any credentials suitable for internal
distribution. Run this command again in interactive mode.
    Error: build command failed.
```

Internal-distribution iOS builds need an Apple Developer Program membership ($99/yr): a
distribution certificate + an ad-hoc provisioning profile listing each test device's UDID.
There is no anonymous-signing path. Do not retry until an Apple Developer account exists; then
run `eas credentials --platform ios` (or just `eas build ... --platform ios` interactively) once
to let EAS create/store the cert + profile, after which `--non-interactive` works.

### Fallback: testing on iPhone without an Apple Developer account

1. **Web (zero install, prod parity)** — open https://musewalk.app in mobile Safari. This is
   the same Expo app exported for web (real data provider, COEP-safe image proxy) and is the
   canonical preview surface today.
2. **Expo Go (native shell, dev server required)** — EAS Update is NOT configured for this
   project, so there is no published update channel to load in Expo Go. Use the dev-server QR
   recipe instead (dev/demo only — this is a metro dev session, not a production build):
   ```sh
   export PATH="$HOME/.nvm/versions/node/v24.14.0/bin:$PATH"
   EXPO_PUBLIC_DATA=real EXPO_PUBLIC_API_URL=https://musewalk.app \
     npx expo start --tunnel        # from apps/mobile; install "Expo Go" from the App Store
   ```
   Scan the printed QR code with the iPhone camera → opens in Expo Go via the `exp://` tunnel
   URL. Phone and laptop need not share a network (ngrok tunnel). Caveats: JS runs in Expo Go's
   runtime (no custom native code — fine for this app: all deps are Expo SDK modules), and the
   session lives only while the dev server runs.
3. **If recurring iOS previews are needed before buying the Apple membership**, configure EAS
   Update (`eas update:configure`) so a published `preview` branch can be loaded in a
   development build — but that still requires a signed dev build on-device, so it does not
   remove the Apple credentials requirement. The web URL remains the practical iOS preview.
