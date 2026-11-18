// Bureau's shell: the whole of the iPhone app that isn't the page.
//
// It began as the file my apps share (APPS/app-store/shell/Shell.swift) and has
// been cut down to what Bureau does. It shows the bundled page in a web view,
// opens the share sheet, gives a tick on taps, opens links in Safari or Mail,
// and keeps a copy of what the page has saved. It has no notifications, no
// links into the app, and no way for a page to ask it for anything else.
import UIKit
import WebKit

/// Where the bundled page lives and what it calls the app.
struct ShellConfig {
    /// The object the page talks to: `window.<bridge>.postMessage(json)`.
    let bridge: String
    /// Where the bundled page appears to live: app://<host><root>...
    let host: String
    let root: String
    /// The page.
    let start: String
    let background: UIColor
}

/// Shows the app's own bundled page in a web view and gives it the two things
/// a page can't do alone: the share sheet and haptics.
final class Shell: UIViewController, WKNavigationDelegate, WKScriptMessageHandler {
    static let scheme = "app"

    let config: ShellConfig
    private(set) var web: WKWebView!
    /// The app is in front again.
    var onActive: () -> Void = {}
    /// Scripts to run before the page's own.
    var scripts: [String] = []

    private let tick = UISelectionFeedbackGenerator()
    private let tap = UIImpactFeedbackGenerator(style: .light)

    init(config: ShellConfig) {
        self.config = config
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func url(_ path: String) -> URL { URL(string: "\(Shell.scheme)://\(config.host)\(path)")! }

    // MARK: Screen

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = config.background

        let setup = WKWebViewConfiguration()
        setup.setURLSchemeHandler(Pages(config: config), forURLScheme: Shell.scheme)
        setup.dataDetectorTypes = []
        let content = setup.userContentController
        content.add(self, name: "shell")
        let bridge = """
        (() => {
          const out = window.webkit.messageHandlers.shell;
          window.\(config.bridge) = { postMessage: s => out.postMessage(String(s)), onmessage: null };
        })();
        """
        for source in [Shell.restoreScript(), bridge, Shell.feel] + scripts where !source.isEmpty {
            content.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        web = WKWebView(frame: view.bounds, configuration: setup)
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.navigationDelegate = self
        web.isOpaque = false
        web.backgroundColor = config.background
        web.scrollView.backgroundColor = config.background
        // The page keeps clear of the notch and home bar itself.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsLinkPreview = false
        #if DEBUG
        web.isInspectable = true
        #endif
        view.addSubview(web)
        web.load(URLRequest(url: url(config.start)))

        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(resigned), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(active), name: UIApplication.didBecomeActiveNotification, object: nil)
    }

    /// What makes the page sit like an app: no pinch or double-tap zoom, no
    /// long-press menus or text selection outside fields, and nothing showing
    /// through behind the clock when the page scrolls.
    private static let feel = #"""
    (() => {
      const style = document.createElement('style');
      style.textContent =
        '*{-webkit-touch-callout:none}' +
        'body{-webkit-user-select:none;user-select:none}' +
        'input,textarea,[contenteditable]{-webkit-user-select:text;user-select:text}' +
        'a,img{-webkit-user-drag:none}' +
        'body::before{content:"";position:fixed;top:0;left:0;right:0;height:env(safe-area-inset-top,0px);background:inherit;z-index:9;pointer-events:none}';
      document.documentElement.appendChild(style);
      const fix = () => {
        const meta = document.querySelector('meta[name="viewport"]');
        if (meta && !/user-scalable/.test(meta.content)) meta.content += ',maximum-scale=1,user-scalable=no';
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fix); else fix();
    })();
    """#

    @objc private func active() { onActive() }
    @objc private func resigned() { keepStorage() }

    // MARK: Messages

    /// To the page: arrives as `<bridge>.onmessage({ data: json })`.
    func send(_ message: [String: Any]) {
        guard isViewLoaded,
              let json = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: json, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed),
              let literal = String(data: quoted, encoding: .utf8) else { return }
        web.evaluateJavaScript("(() => { const a = window.\(config.bridge); if (a && typeof a.onmessage === 'function') a.onmessage({ data: \(literal) }); })()", completionHandler: nil)
    }

    /// From the page. There are three messages, and anything else is dropped.
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        // Only the app's own page is ever the main frame: anything else opens in Safari.
        guard message.frameInfo.isMainFrame, web.url?.scheme == Shell.scheme,
              let text = message.body as? String, let data = text.data(using: .utf8),
              let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let type = msg["type"] as? String else { return }
        switch type {
        case "hello":
            // The page shows the version on its About page.
            send([
                "type": "info",
                "version": Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "",
            ])
        case "share":
            let sheet = UIActivityViewController(activityItems: [msg["text"] as? String ?? ""], applicationActivities: nil)
            sheet.popoverPresentationController?.sourceView = view
            sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.maxY - 80, width: 1, height: 1)
            if presentedViewController == nil { present(sheet, animated: true) }
        case "haptic":
            if msg["kind"] as? String == "tick" { tick.selectionChanged() } else { tap.impactOccurred() }
        default:
            break
        }
    }

    // MARK: Leaving the app's page

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        if url.scheme == Shell.scheme || url.scheme == "about" { return decisionHandler(.allow) }
        if let frame = navigationAction.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        leave(to: url)
        decisionHandler(.cancel)
    }

    /// Opens a link outside the app. With no mail app set up, an email link
    /// would do nothing, so the address is shown instead.
    private func leave(to url: URL) {
        UIApplication.shared.open(url) { [weak self] opened in
            guard !opened, url.scheme == "mailto", let self, self.presentedViewController == nil else { return }
            let address = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path ?? ""
            guard !address.isEmpty else { return }
            let alert = UIAlertController(title: "No mail app is set up", message: "Email \(address) from any device.", preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Copy address", style: .default) { _ in UIPasteboard.general.string = address })
            alert.addAction(UIAlertAction(title: "OK", style: .cancel))
            self.present(alert, animated: true)
        }
    }

    /// iOS ended the page's process to free memory: start the page again.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if webView.url == nil { webView.load(URLRequest(url: url(config.start))) } else { webView.reload() }
    }

    // MARK: Keeping what the page stores

    // The page keeps its settings and last rates in web storage, which iOS may
    // clear when the phone runs short of space. Each time the app leaves the
    // front, a copy of that storage goes in one file in the app's own folder
    // (Application Support/storage.json, which is in the phone's backup). At
    // launch, if the page's storage is found empty, the copy is put back before
    // the page runs. It is data only: the saved text is parsed as JSON and set
    // as storage values, never run. Nothing is sent anywhere.
    private static var storageFile: URL {
        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("storage.json")
    }

    private static func restoreScript() -> String {
        // Read as JSON, written out again, and handed to the page as one quoted
        // string for JSON.parse: whatever the file holds, it can only become values.
        guard let data = try? Data(contentsOf: storageFile),
              let saved = (try? JSONSerialization.jsonObject(with: data)) as? [String: String], !saved.isEmpty,
              let clean = try? JSONSerialization.data(withJSONObject: saved),
              let text = String(data: clean, encoding: .utf8),
              let quoted = try? JSONSerialization.data(withJSONObject: text, options: .fragmentsAllowed),
              let literal = String(data: quoted, encoding: .utf8) else { return "" }
        return "(() => { try { if (!localStorage.length) { const s = JSON.parse(\(literal)); for (const k in s) localStorage.setItem(k, s[k]); } } catch (e) {} })();"
    }

    func keepStorage() {
        guard isViewLoaded, web.url?.scheme == Shell.scheme else { return }
        web.evaluateJavaScript("JSON.stringify(localStorage)") { value, _ in
            guard let text = value as? String, text.hasPrefix("{"), let data = text.data(using: .utf8) else { return }
            try? data.write(to: Shell.storageFile, options: .atomic)
        }
    }
}

/// Serves the bundled web folder to the web view.
final class Pages: NSObject, WKURLSchemeHandler {
    private let config: ShellConfig
    private let folder: URL
    // The kinds of file in the folder.
    private static let types = [
        "html": "text/html; charset=utf-8", "js": "text/javascript; charset=utf-8",
        "png": "image/png", "woff2": "font/woff2", "txt": "text/plain; charset=utf-8",
    ]

    init(config: ShellConfig) {
        self.config = config
        folder = Bundle.main.resourceURL!.appendingPathComponent("web", isDirectory: true).standardizedFileURL
    }

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url, let file = file(for: url.path), let data = try? Data(contentsOf: file) else {
            return task.didFailWithError(URLError(.fileDoesNotExist))
        }
        let type = Pages.types[file.pathExtension.lowercased()] ?? "application/octet-stream"
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-cache"]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            return task.didFailWithError(URLError(.badServerResponse))
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

    private func file(for path: String) -> URL? {
        guard path.hasPrefix(config.root) else { return nil }
        var rest = String(path.dropFirst(config.root.count))
        if rest.isEmpty || rest.hasSuffix("/") { rest += "index.html" }
        let file = folder.appendingPathComponent(rest).standardizedFileURL
        var isFolder: ObjCBool = false
        if file.path.hasPrefix(folder.path + "/"), FileManager.default.fileExists(atPath: file.path, isDirectory: &isFolder), !isFolder.boolValue { return file }
        return nil
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let scene = UISceneConfiguration(name: "Default", sessionRole: connectingSceneSession.role)
        scene.delegateClass = SceneDelegate.self
        return scene
    }
}

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let shell = Shell(config: App.config)
        App.setUp(shell)
        let window = UIWindow(windowScene: scene)
        window.backgroundColor = App.config.background
        window.rootViewController = shell
        window.makeKeyAndVisible()
        self.window = window
    }
}
