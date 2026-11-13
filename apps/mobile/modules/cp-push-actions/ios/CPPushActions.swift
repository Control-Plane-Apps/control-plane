// Fork-owned. Runs Control Plane notification buttons that must work while
// the app is closed or the phone is locked: Answer (a Status question),
// Complete (a task reminder) and Snooze 1 hour. Reply opens the app and is
// routed by JS.
//
// The push carries `cp.actionUrl` (this Mac, as the phone reaches it) and
// `cp.actionToken`, a server-signed token naming exactly one question version
// or task. The server refuses an outdated version; the phone then shows why.

import ExpoModulesCore
import ExpoNotifications
import Foundation
import UIKit
import UserNotifications

let CPActionAnswer = "cp.answer"
let CPActionComplete = "cp.complete"
let CPActionSnooze = "cp.snooze"
let CPSnoozeSeconds: TimeInterval = 60 * 60

public class CPPushActionsAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    NotificationCenterManager.shared.addDelegate(CPPushActionHandler.shared)
    return true
  }
}

final class CPPushActionHandler: NSObject, NotificationDelegate {
  static let shared = CPPushActionHandler()

  func didReceive(
    _ response: UNNotificationResponse,
    completionHandler: @escaping () -> Void
  ) -> Bool {
    let action = response.actionIdentifier
    guard action == CPActionAnswer || action == CPActionComplete || action == CPActionSnooze else {
      return false
    }
    let content = response.notification.request.content
    guard let cp = content.userInfo["cp"] as? [String: Any] else { return false }
    let identifier = response.notification.request.identifier

    if action == CPActionSnooze {
      CPPushActionHandler.snooze(content: content, identifier: identifier)
      return true
    }
    guard
      let urlString = cp["actionUrl"] as? String,
      let url = URL(string: urlString),
      let token = cp["actionToken"] as? String
    else {
      CPPushActionHandler.notify(
        title: "Couldn't do that from the notification",
        body: "Open Control Plane to finish it.",
        userInfo: content.userInfo
      )
      return true
    }
    CPPushActionHandler.post(
      url: url,
      token: token,
      action: action == CPActionAnswer ? "answer" : "complete",
      content: content,
      cp: cp
    )
    return true
  }

  /// Shows the same notification again in an hour.
  static func snooze(content: UNNotificationContent, identifier: String) {
    guard let copy = content.mutableCopy() as? UNMutableNotificationContent else { return }
    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: CPSnoozeSeconds, repeats: false)
    let request = UNNotificationRequest(
      identifier: "snoozed:\(identifier)", content: copy, trigger: trigger)
    UNUserNotificationCenter.current().add(request)
  }

  static func post(
    url: URL,
    token: String,
    action: String,
    content: UNNotificationContent,
    cp: [String: Any]
  ) {
    // The notification center's completion handler has already returned, so
    // keep the app alive for the request on our own.
    var task: UIBackgroundTaskIdentifier = .invalid
    task = UIApplication.shared.beginBackgroundTask(withName: "cp.push-action") {
      UIApplication.shared.endBackgroundTask(task)
      task = .invalid
    }
    var request = URLRequest(url: url, timeoutInterval: 20)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONSerialization.data(withJSONObject: ["action": action])
    URLSession.shared.dataTask(with: request) { data, response, error in
      defer {
        if task != .invalid {
          UIApplication.shared.endBackgroundTask(task)
          task = .invalid
        }
      }
      let status = (response as? HTTPURLResponse)?.statusCode ?? 0
      let subject = (cp["statusTitle"] as? String) ?? content.title
      if status == 204 || status == 200 { return }
      if error != nil || status == 0 {
        // The Mac was unreachable (asleep, or Tailscale off). Offer it again.
        notify(
          title: "Couldn't reach your Mac",
          body: "Your answer to \(subject) wasn't sent. Try again when your Mac is awake.",
          userInfo: content.userInfo,
          categoryIdentifier: content.categoryIdentifier
        )
        return
      }
      var refusal = ""
      if let data = data,
        let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
      {
        refusal = (json["refusal"] as? String) ?? ""
      }
      switch refusal {
      case "outdated":
        notify(
          title: "Couldn't answer \(subject)",
          body: "The question changed since you saw it. Open Status to review it.",
          userInfo: content.userInfo
        )
      case "answered":
        notify(
          title: "\(subject) was already answered",
          body: "Nothing new was sent.",
          userInfo: content.userInfo
        )
      default:
        notify(
          title: "Couldn't do that from the notification",
          body: "Open Control Plane to finish it.",
          userInfo: content.userInfo
        )
      }
    }.resume()
  }

  static func notify(
    title: String,
    body: String,
    userInfo: [AnyHashable: Any],
    categoryIdentifier: String? = nil
  ) {
    let content = UNMutableNotificationContent()
    content.title = title
    content.body = body
    content.userInfo = userInfo
    if let categoryIdentifier = categoryIdentifier { content.categoryIdentifier = categoryIdentifier }
    let request = UNNotificationRequest(
      identifier: "cp.action-result:\(UUID().uuidString)", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }
}
