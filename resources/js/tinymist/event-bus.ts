type Listener = (data: any) => void;

export class EventBus {
    protected listeners: Record<string, Set<Listener>> = {};

    /**
     * Emit a custom event for any handlers to pick-up.
     */
    emit(eventName: string, eventData: {} = {}): void {

        const listenersToRun = this.listeners[eventName] ?? new Set<Listener>();
        for (const listener of listenersToRun) {
            listener(eventData);
        }
    }

    /**
     * Listen to a custom event and run the given callback when that event occurs.
     */
    listen<T>(eventName: string, callback: (data: T) => void): void {
        if (typeof this.listeners[eventName] === 'undefined') this.listeners[eventName] = new Set<Listener>();
        this.listeners[eventName].add(callback as Listener);
    }

    /**
     * Remove an event listener which is using the given callback for the given event name.
     */
    remove(eventName: string, callback: Listener): void {
        const listeners = this.listeners[eventName];
        if (!listeners) return;
        listeners.delete(callback);
    }

    /**
     * Remove all listeners so references can be released.
     */
    destroy(): void {
        for (const eventName of Object.keys(this.listeners)) {
            this.listeners[eventName].clear();
        }
        this.listeners = {};
    }

    /**
     * Emit an event for public use.
     * Sends the event via the native DOM event handling system.
     */
    emitPublic(targetElement: Element, eventName: string, eventData: {}): void {
        const event = new CustomEvent(eventName, {
            detail: eventData,
            bubbles: true,
        });
        targetElement.dispatchEvent(event);
    }
}
