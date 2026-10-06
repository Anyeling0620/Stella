import { STORAGE_KEYS } from '../config';
import { writeJSON, uid } from './storage';

/**
 * Cross-tab messaging bus.
 *
 * Prefers `BroadcastChannel` and degrades to `StorageEvent` (the strategy named
 * in the design doc) when the former is unavailable. Both mechanisms deliver
 * messages to *other* tabs only — never to the sender — which gives the two
 * transports identical semantics.
 */
type Handler = (payload: unknown) => void;

interface BusEnvelope {
  payload: unknown;
  nonce: string;
  at: number;
}

class CrossTabBus {  // 这是一个跨标签页消息总线类，用于在同一浏览器的不同标签页之间传递消息。它优先使用 `BroadcastChannel` API，如果不可用，则降级为使用 `StorageEvent` 机制。该类提供了消息发布和订阅功能，允许不同标签页之间进行通信，同时确保消息不会发送回发送者自身，从而实现一致的语义。
  readonly tabId = uid();
  readonly kind: 'broadcast-channel' | 'storage-event';

  private readonly handlers = new Set<Handler>();
  private readonly channel: BroadcastChannel | null = null;
  private readonly storageListener: ((event: StorageEvent) => void) | null = null;

  constructor() {
    if (typeof BroadcastChannel !== 'undefined') {
      this.kind = 'broadcast-channel';
      this.channel = new BroadcastChannel('stella-im-bus');
      this.channel.onmessage = (event) => this.deliver(event.data);
    } else {
      this.kind = 'storage-event';
      this.storageListener = (event) => {
        if (event.key !== STORAGE_KEYS.bus || !event.newValue) return;
        try {
          this.deliver((JSON.parse(event.newValue) as BusEnvelope).payload);
        } catch {
          /* ignore malformed payloads */
        }
      };
      window.addEventListener('storage', this.storageListener);
    }
  }

  private deliver(payload: unknown): void {
    for (const handler of this.handlers) {
      try {
        handler(payload);
      } catch {
        /* a broken subscriber must not break the bus */
      }
    }
  }

  post(payload: unknown): void {
    if (this.channel) {
      this.channel.postMessage(payload);
      return;
    }
    // The nonce guarantees the value differs each time so the event always fires.
    writeJSON(STORAGE_KEYS.bus, { payload, nonce: uid(), at: Date.now() } satisfies BusEnvelope);
  }

  subscribe(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export const bus = new CrossTabBus();

/** Shared cross-tab message shapes. */
export const BUS = {
  FRAME: 'bus:frame',
  POLL: 'bus:poll',
  STATUS: 'bus:status',
  LEADER: 'bus:leader',
  LEADER_HEARTBEAT: 'bus:leader-heartbeat',
  SESSION_INVALID: 'bus:session-invalid',
} as const;
