import { pushApi } from './api';

/**
 * Web Push client helpers.
 *
 * Registers the service worker, subscribes with the server's VAPID key, and
 * pushes the subscription to the backend. `enablePush` MUST be called from a
 * user gesture (browsers require it for Notification.requestPermission).
 */

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window;
}

async function registerWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!pushSupported()) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js');
  } catch {
    return null;
  }
}

/** True when this browser already holds an active push subscription. */
export async function isPushSubscribed(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return false;
  const sub = await reg.pushManager.getSubscription();
  return !!sub;
}

/** Enables push: permission + subscription + server registration. */
export async function enablePush(): Promise<void> {
  const reg = await registerWorker();
  if (!reg) throw new Error('当前浏览器不支持离线推送');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('未获得通知权限，请在浏览器设置中开启');

  const { enabled, publicKey } = await pushApi.publicKey();
  if (!enabled || !publicKey) throw new Error('服务端未启用离线推送');

  const existing = await reg.pushManager.getSubscription();
  const subscription =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }));

  await pushApi.subscribe(subscription.toJSON());
}

/** Disables push: unsubscribe locally + tell the server to forget the endpoint. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => {});
    await pushApi.unsubscribe(endpoint).catch(() => {});
  }
}

/** Listens for the SW's notification-click "open conversation" message. */
export function onPushOpenConversation(handler: (conversationId: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: string; conversationId?: string } | undefined;
    if (data && data.type === 'open-conversation' && data.conversationId) handler(data.conversationId);
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}
