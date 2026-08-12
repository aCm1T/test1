export type EventKey<Events extends object> = Extract<
  keyof Events,
  string | symbol
>;

export type EventListener<
  Events extends object,
  Key extends EventKey<Events>,
> = (payload: Events[Key]) => void;

export interface EventSubscriptionOptions {
  /** Higher-priority listeners run first. Equal priorities preserve order. */
  priority?: number;
  /** Remove the listener before its first invocation. */
  once?: boolean;
  /** Automatically unsubscribe when the signal is aborted. */
  signal?: AbortSignal;
}

export interface EventBusOptions {
  /** If supplied, listener errors are reported here instead of rethrown. */
  onListenerError?: (error: unknown, event: string | symbol) => void;
}

interface ListenerRecord {
  listener: (payload: unknown) => void;
  priority: number;
  sequence: number;
  once: boolean;
  active: boolean;
  removeAbortListener?: () => void;
}

/**
 * Small synchronous typed event bus with deterministic listener ordering.
 * Listener-list mutation during an emit is safe: additions wait until the next
 * emit, and removals prevent a not-yet-invoked listener from running.
 */
export class TypedEventBus<Events extends object> {
  private readonly listeners = new Map<keyof Events, ListenerRecord[]>();
  private readonly onListenerError?: EventBusOptions['onListenerError'];
  private nextSequence = 0;
  private disposed = false;

  constructor(options: EventBusOptions = {}) {
    this.onListenerError = options.onListenerError;
  }

  on<Key extends EventKey<Events>>(
    event: Key,
    listener: EventListener<Events, Key>,
    options: EventSubscriptionOptions = {},
  ): () => void {
    this.assertActive();

    if (options.signal?.aborted) return () => undefined;

    const record: ListenerRecord = {
      listener: listener as (payload: unknown) => void,
      priority: Number.isFinite(options.priority) ? options.priority! : 0,
      sequence: this.nextSequence,
      once: options.once ?? false,
      active: true,
    };
    this.nextSequence += 1;

    const records = this.listeners.get(event) ?? [];
    records.push(record);
    records.sort(
      (left, right) =>
        right.priority - left.priority || left.sequence - right.sequence,
    );
    this.listeners.set(event, records);

    const unsubscribe = (): void => {
      if (!record.active) return;
      record.active = false;
      record.removeAbortListener?.();
      const current = this.listeners.get(event);
      if (!current) return;
      const index = current.indexOf(record);
      if (index >= 0) current.splice(index, 1);
      if (current.length === 0) this.listeners.delete(event);
    };

    if (options.signal) {
      const onAbort = (): void => unsubscribe();
      options.signal.addEventListener('abort', onAbort, { once: true });
      record.removeAbortListener = () =>
        options.signal?.removeEventListener('abort', onAbort);
    }

    return unsubscribe;
  }

  once<Key extends EventKey<Events>>(
    event: Key,
    listener: EventListener<Events, Key>,
    options: Omit<EventSubscriptionOptions, 'once'> = {},
  ): () => void {
    return this.on(event, listener, { ...options, once: true });
  }

  emit<Key extends EventKey<Events>>(event: Key, payload: Events[Key]): number {
    if (this.disposed) return 0;
    const current = this.listeners.get(event);
    if (!current || current.length === 0) return 0;

    const snapshot = current.slice();
    const errors: unknown[] = [];
    let invoked = 0;

    for (const record of snapshot) {
      if (!record.active) continue;
      if (record.once) this.removeRecord(event, record);
      invoked += 1;
      try {
        record.listener(payload);
      } catch (error) {
        if (this.onListenerError) {
          this.onListenerError(error, event);
        } else {
          errors.push(error);
        }
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, `Multiple listeners failed for ${String(event)}`);
    }
    return invoked;
  }

  listenerCount<Key extends EventKey<Events>>(event: Key): number {
    return this.listeners.get(event)?.length ?? 0;
  }

  clear<Key extends EventKey<Events>>(event?: Key): void {
    if (event !== undefined) {
      const records = this.listeners.get(event);
      records?.forEach((record) => this.deactivate(record));
      this.listeners.delete(event);
      return;
    }

    for (const records of this.listeners.values()) {
      records.forEach((record) => this.deactivate(record));
    }
    this.listeners.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.clear();
    this.disposed = true;
  }

  private removeRecord(event: keyof Events, record: ListenerRecord): void {
    this.deactivate(record);
    const records = this.listeners.get(event);
    if (!records) return;
    const index = records.indexOf(record);
    if (index >= 0) records.splice(index, 1);
    if (records.length === 0) this.listeners.delete(event);
  }

  private deactivate(record: ListenerRecord): void {
    if (!record.active) return;
    record.active = false;
    record.removeAbortListener?.();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('Cannot subscribe to a disposed TypedEventBus');
    }
  }
}

/** Concise alias for application event-map declarations. */
export { TypedEventBus as EventBus };
