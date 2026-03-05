type EventPayloadMap = Record<string, unknown>;
type Listener<T> = (data: T) => void;

export class EventBus<TEvents extends EventPayloadMap = Record<string, unknown>> {
    protected listeners: Partial<{ [K in keyof TEvents]: Set<Listener<TEvents[K]>> }> = {};

    /**
     * Emit a custom event for any handlers to pick-up.
     */
    emit<K extends keyof TEvents>(eventName: K, ...eventData: TEvents[K] extends undefined ? [] : [TEvents[K]]): void {

        const listenersToRun = this.listeners[eventName] ?? new Set<Listener<TEvents[K]>>();
        const payload = eventData[0] as TEvents[K];
        for (const listener of listenersToRun) {
            listener(payload);
        }
    }

    /**
     * Listen to a custom event and run the given callback when that event occurs.
     */
    listen<K extends keyof TEvents>(eventName: K, callback: Listener<TEvents[K]>): void {
        if (!this.listeners[eventName]) {
            this.listeners[eventName] = new Set<Listener<TEvents[K]>>();
        }
        this.listeners[eventName].add(callback);
    }

    /**
     * Remove an event listener which is using the given callback for the given event name.
     */
    remove<K extends keyof TEvents>(eventName: K, callback: Listener<TEvents[K]>): void {
        const listeners = this.listeners[eventName];
        if (!listeners) return;
        listeners.delete(callback);
    }

    /**
     * Remove all listeners so references can be released.
     */
    destroy(): void {
        for (const eventName of Object.keys(this.listeners)) {
            this.listeners[eventName as keyof TEvents]?.clear();
        }
        this.listeners = {};
    }

    /**
     * Emit an event for public use.
     * Sends the event via the native DOM event handling system.
     */
    emitPublic<K extends keyof TEvents>(targetElement: Element, eventName: K, eventData: TEvents[K]): void {
        const event = new CustomEvent(String(eventName), {
            detail: eventData,
            bubbles: true,
        });
        targetElement.dispatchEvent(event);
    }
}
