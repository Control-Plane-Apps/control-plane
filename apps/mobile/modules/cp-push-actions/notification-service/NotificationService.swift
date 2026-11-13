// Fork-owned. Gives each Status question notification its own buttons: the
// first one is labeled with the coordinator's short answer ("Retry 3 times"),
// then Reply and Snooze 1 hour. iOS category buttons are static, so this
// extension registers a category per answer label before the notification shows.

import UserNotifications

class NotificationService: UNNotificationServiceExtension {
  private static let statusCategory = "cp.status-question"
  private static let maxDynamicCategories = 48

  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard
      let content = request.content.mutableCopy() as? UNMutableNotificationContent,
      let cp = content.userInfo["cp"] as? [String: Any],
      cp["kind"] as? String == "status-question",
      let label = (cp["answerLabel"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
      !label.isEmpty,
      cp["actionToken"] is String
    else {
      contentHandler(request.content)
      return
    }
    bestAttempt = content
    let categoryId = "\(Self.statusCategory).\(Self.stableId(label))"
    let center = UNUserNotificationCenter.current()
    center.getNotificationCategories { existing in
      var categories = existing
      if !categories.contains(where: { $0.identifier == categoryId }) {
        let dynamic = categories.filter { $0.identifier.hasPrefix("\(Self.statusCategory).") }
        if dynamic.count >= Self.maxDynamicCategories, let oldest = dynamic.first {
          categories.remove(oldest)
        }
        categories.insert(Self.statusQuestionCategory(id: categoryId, answer: label))
        center.setNotificationCategories(categories)
      }
      content.categoryIdentifier = categoryId
      // Registration is asynchronous inside the system; give it a moment so
      // the buttons are there when the notification is first expanded.
      DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
        contentHandler(content)
      }
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler = contentHandler, let bestAttempt = bestAttempt {
      contentHandler(bestAttempt)
    }
  }

  static func statusQuestionCategory(id: String, answer: String) -> UNNotificationCategory {
    UNNotificationCategory(
      identifier: id,
      actions: [
        UNNotificationAction(
          identifier: "cp.answer", title: answer, options: [],
          icon: UNNotificationActionIcon(systemImageName: "checkmark")),
        UNNotificationAction(
          identifier: "cp.reply", title: "Reply", options: [.foreground],
          icon: UNNotificationActionIcon(systemImageName: "arrowshape.turn.up.left")),
        UNNotificationAction(
          identifier: "cp.snooze", title: "Snooze 1 hour", options: [],
          icon: UNNotificationActionIcon(systemImageName: "clock")),
      ],
      intentIdentifiers: [],
      options: [])
  }

  /// FNV-1a: the same label always maps to the same category.
  static func stableId(_ text: String) -> String {
    var hash: UInt64 = 0xcbf2_9ce4_8422_2325
    for byte in text.utf8 {
      hash ^= UInt64(byte)
      hash = hash &* 0x100_0000_01b3
    }
    return String(hash, radix: 16)
  }
}
