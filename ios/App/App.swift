import UIKit

/// Bureau on iPhone: the converter page, kept in the app.
@MainActor
enum App {
    // The page takes this address to mean it is inside the app, so it leaves
    // the website's offline worker and home-screen hint alone.
    static let config = ShellConfig(
        bridge: "bureauApp",
        host: "appassets.androidplatform.net",
        root: "/assets/",
        start: "/assets/index.html",
        background: UIColor(named: "Page") ?? .systemBackground
    )

    static func launched() {}

    static func setUp(_ shell: Shell) {
        // Read by the page before it draws: no widget, no rate alerts, and the
        // keys above the keyboard placed as they are in Safari.
        var scripts = ["window.bureauApp.ios = true;"]
        // Numbers are written the way this phone writes them.
        if let language = Locale.preferredLanguages.first,
           language.range(of: "^[A-Za-z0-9-]{2,35}$", options: .regularExpression) != nil {
            scripts.append("window.bureauApp.locale = \"\(language)\";")
        }
        shell.scripts = scripts
        shell.onMessage = { type, _ in
            switch type {
            case "notificationSettings":
                if let settings = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(settings) }
                return true
            // Nothing to do on an iPhone: no widget, no Back gesture, no rate
            // alerts, and updates come from the App Store.
            case "pair", "picker", "setAlert", "removeAlert", "checkUpdate", "installUpdate":
                return true
            default:
                return false
            }
        }
    }

    static func opened(link: URL) {}
    static func opened(notification: [AnyHashable: Any]) {}
}
