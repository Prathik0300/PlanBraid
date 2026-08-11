import webpush from "web-push";

export type PushEnvironment = {
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
};

type Row = Record<string, unknown>;

export function validatePushEndpoint(endpoint: string) {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw invalidSubscription(); }
  const hostname = url.hostname.toLowerCase();
  const unsafe = url.protocol !== "https:"
    || hostname === "localhost"
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || /^127\./.test(hostname)
    || /^10\./.test(hostname)
    || /^192\.168\./.test(hostname)
    || /^169\.254\./.test(hostname)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    || hostname === "::1";
  if (unsafe) throw invalidSubscription();
}

function invalidSubscription() {
  return Object.assign(new Error("The push subscription endpoint is not allowed"), { code: "INVALID_PUSH_SUBSCRIPTION", status: 422 });
}

export async function dispatchNotification(db: D1Database, notificationId: string, pushEnv: PushEnvironment) {
  if (!pushEnv.VAPID_PUBLIC_KEY || !pushEnv.VAPID_PRIVATE_KEY) {
    return { sent: 0, skipped: true, reason: "vapid_not_configured" };
  }
  const notification = await db.prepare("SELECT * FROM notifications WHERE id = ?").bind(notificationId).first<Row>();
  if (!notification) return { sent: 0, skipped: true, reason: "notification_not_found" };
  const subscriptions = await db.prepare("SELECT id, endpoint, subscription FROM push_subscriptions WHERE organization_id = ? AND owner_user_id = ? AND active = 1").bind(notification.organization_id, notification.recipient_user_id).all<Row>();
  const payload = JSON.stringify({
    title: String(notification.title),
    body: String(notification.body),
    url: String(notification.deep_link),
    tag: `planbraid-${String(notification.dedupe_key).slice(-32)}`,
    priority: String(notification.priority),
  });
  let sent = 0;
  let failed = 0;
  await Promise.all(subscriptions.results.map(async (row) => {
    try {
      validatePushEndpoint(String(row.endpoint));
      const subscription = JSON.parse(String(row.subscription)) as webpush.PushSubscription;
      const details = webpush.generateRequestDetails(subscription, payload, {
        TTL: 60 * 60 * 24,
        urgency: notification.priority === "high" ? "high" : "normal",
        topic: String(notification.dedupe_key).replace(/[^a-zA-Z0-9_-]/g, "-").slice(-32),
        vapidDetails: {
          subject: pushEnv.VAPID_SUBJECT ?? "mailto:notifications@planbraid.app",
          publicKey: pushEnv.VAPID_PUBLIC_KEY!,
          privateKey: pushEnv.VAPID_PRIVATE_KEY!,
        },
      });
      const response = await fetch(details.endpoint, {
        method: "POST",
        headers: details.headers,
        body: details.body ? new Uint8Array(details.body) : null,
      });
      if (!response.ok) {
        if (response.status === 404 || response.status === 410) {
          await db.prepare("UPDATE push_subscriptions SET active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id).run();
        }
        throw new Error(`Push service returned ${response.status}`);
      }
      sent += 1;
      await db.prepare("UPDATE push_subscriptions SET last_success_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(row.id).run();
    } catch {
      failed += 1;
    }
  }));
  return { sent, failed, skipped: false };
}
