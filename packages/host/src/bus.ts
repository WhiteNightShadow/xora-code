import type { HostNotifications, NotificationParams } from '@xora/protocol';

type Name = keyof HostNotifications & string;

export interface Subscriber {
    notify(method: Name, params: unknown): void;
}

/**
 * Fan-out of host notifications to connected UIs. Thread events and deltas only go to UIs that subscribed to
 * that thread; everything else (sidebar metadata, approvals) goes to every UI.
 */
export class Bus {
    readonly #subscribers = new Set<Subscriber>();
    readonly #threads = new Map<Subscriber, Set<string>>();
    #focused = true;

    add(subscriber: Subscriber): () => void {
        this.#subscribers.add(subscriber);
        this.#threads.set(subscriber, new Set());
        return () => {
            this.#subscribers.delete(subscriber);
            this.#threads.delete(subscriber);
        };
    }

    subscribe(subscriber: Subscriber, threadId: string): void {
        this.#threads.get(subscriber)?.add(threadId);
    }

    unsubscribe(subscriber: Subscriber, threadId: string): void {
        this.#threads.get(subscriber)?.delete(threadId);
    }

    get connected(): number {
        return this.#subscribers.size;
    }

    /** Whether a UI window currently has focus; system notifications are only raised when it does not. */
    get focused(): boolean {
        return this.#focused && this.#subscribers.size > 0;
    }

    setFocused(focused: boolean): void {
        this.#focused = focused;
    }

    broadcast<N extends Name>(method: N, params: NotificationParams<N>): void {
        for (const subscriber of this.#subscribers) {
            subscriber.notify(method, params);
        }
    }

    toThread<N extends Name>(threadId: string, method: N, params: NotificationParams<N>): void {
        for (const [subscriber, threads] of this.#threads) {
            if (threads.has(threadId)) {
                subscriber.notify(method, params);
            }
        }
    }
}
