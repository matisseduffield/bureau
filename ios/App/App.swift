import UIKit

/// Bureau on iPhone: the converter page, kept in the app.
///
/// The page is the folder `web` in the app, which is `ios/bundle/web`: the
/// shared page without the parts only the website and the Android app use
/// (see scripts/ios-bundle.mjs). What it can ask of the app is in Shell.swift:
/// the share sheet and a tick on taps. Nothing else.
@MainActor
enum App {
    static let config = ShellConfig(
        bridge: "bureauApp",
        host: "bureau",
        root: "/assets/",
        start: "/assets/index.html",
        background: UIColor(named: "Page") ?? .systemBackground
    )

    static func setUp(_ shell: Shell) {
        // Read by the page before it draws.
        var scripts: [String] = []
        // Numbers are written the way this phone writes them.
        if let language = Locale.preferredLanguages.first,
           language.range(of: "^[A-Za-z0-9-]{2,35}$", options: .regularExpression) != nil {
            scripts.append("window.bureauApp.locale = \"\(language)\";")
        }
        // The decimal and thousands marks can be set apart from the language, and
        // the keypad follows them. Passed as character numbers, so nothing needs quoting.
        if let decimal = Locale.current.decimalSeparator?.unicodeScalars.first?.value,
           let group = Locale.current.groupingSeparator?.unicodeScalars.first?.value {
            scripts.append("window.bureauApp.decimal = String.fromCodePoint(\(decimal)); window.bureauApp.group = String.fromCodePoint(\(group));")
        }
        shell.scripts = scripts
        // Back in front: the page checks whether its rates are due a refresh.
        shell.onActive = { [weak shell] in shell?.send(["type": "active"]) }
    }
}
