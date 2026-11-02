# Bureau

Live currency converter. The whole converter is one page, [`web/index.html`](web/index.html);
the Android app in `app/` wraps it in a WebView and adds self-updates.

## Features
- Live mid-market rates from Coinbase, refreshed every minute, checked against ExchangeRate-API's
  daily rates (used instead where Coinbase is more than 10% off, and as the fallback)
- Convert in either direction, swap, and search about 160 currencies by name, code or country, plus ten major coins;
  recently used currencies sit at the top of the picker
- Simple sums in the amount fields (`12*3.5`, `(40+25)/2`), with + − × ÷ keys above the phone keyboard
- Optional bank/card fee (presets or a custom %) applied to every result, with the mid-market rate still shown
- 1W / 1M / 1Y trend from European Central Bank reference rates, or daily snapshots
  (fawazahmed0/currency-api) for crypto and currencies the ECB doesn't cover
- Rate alerts (app only): the bell beside the rate sets a target; a background job checks
  every 30 minutes and sends one notification when it's reached
- Quick amounts in both directions
- Remembers the pair, amount, fee and trend range; light and dark themes
- Home-screen widget with the converter's amount (or the plain rate) for the current pair
  (refreshes every 30 minutes and whenever the app is used)
- Works offline from the first launch: release builds bundle a rates snapshot (`web/snapshot.json`, generated in CI)
- Hanken Grotesk is bundled in `web/fonts/` (SIL OFL) so the app looks the same offline

## Run the page
Open `web/index.html` in a browser, or use the `currency` preview config in
`../.claude/launch.json` (serves `web/` on port 5180).

## Tests
The page's pure logic (number parsing, sums, formatting options, rate merging)
lives in `web/lib.js` and is tested on every push:

```
node --test "tests/*.test.js"
```

## Build the app
Toolchain lives in `C:\Users\matisse\android-toolchain\` (JDK 17, Android SDK 36, Gradle 8.14.2):

```powershell
$env:JAVA_HOME = "C:\Users\matisse\android-toolchain\jdk"
.\gradlew.bat :app:assembleRelease :app:lintRelease
```

Output: `app\build\outputs\apk\release\app-release.apk`.

Signing is never committed: local builds read the untracked
`keystore.properties` + `bureau-release.keystore` (backups at
`C:\Users\matisse\android-toolchain\bureau-release.keystore.backup` and
`bureau-keystore.properties.backup`); CI restores them from the repo's
encrypted Actions secrets (`KEYSTORE_BASE64`, `KEYSTORE_PASSWORD`, `KEY_ALIAS`,
`KEY_PASSWORD`). **Keep the keystore**: future updates must be signed with it
to install over the existing app.

## Updates
This repo is private, so phones can't read its releases. Each release build
also publishes the APK and a `latest.json` to the public
[bureau-releases](https://github.com/matisseduffield/bureau-releases) repo,
using a deploy key (`RELEASES_DEPLOY_KEY` secret here, write-enabled deploy
key there). The app checks that file on launch (then at most every 6 hours),
verifies the download's SHA-256, and installs it over itself.

Inside the app the version shows at the top right; tapping it checks for updates. The app talks to the page through a WebView message listener limited
to its own asset origin (`window.bureauApp`): the page reports the pair and amount (for the
widget), sets and removes rate alerts, and says when the picker or a menu is open (so Back closes it).

New updates show as a card at the top of the page (version, what's new, size,
then download progress) with one Update button; Android's own confirm screen
follows. WebViews without the message bridge get a system dialog instead.

Publishing an update = push an annotated `v*` tag whose message lists what's new
as `- ` lines; those lines become the card's notes and the releases README:

```
git tag -a v1.5.0 -m "Bureau 1.5.0" -m "- First change" -m "- Second change"
git push origin v1.5.0
```

New installs: `https://raw.githubusercontent.com/matisseduffield/bureau-releases/main/Bureau.apk`
always serves the latest build.
The version name and code come from the tag (`1.1.0` → versionCode `10100`).

- `applicationId` com.matisseduffield.bureau · minSdk 27 · target/compile SDK 36
