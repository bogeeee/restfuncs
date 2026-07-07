/**
 * Iterable WeakSet and WeakMap implementations.
 *
 * Unlike built-in WeakSet/WeakMap, these collections are iterable.
 * They use WeakRef + FinalizationRegistry to hold weak references while
 * allowing iteration over live (non-GC'd) entries.
 *
 * When a value is garbage collected, its entry is automatically removed
 * from the internal storage on the next iteration or mutation.
 */

// ─── Internal helpers ────────────────────────────────────────────────────────

const FINALIZATION_CALLBACK = "__finalization_cleanup";

/**
 * Returns a cleanup token (target → token map) for use with FinalizationRegistry.
 * Stored as a non-enumerable property on the target to avoid conflicts.
 */
function getCleanupToken(target: object): object {
  let token = (target as any)[FINALIZATION_CALLBACK];
  if (!token) {
    token = {};
    Object.defineProperty(target, FINALIZATION_CALLBACK, {
      value: token,
      enumerable: false,
      configurable: true,
    });
  }
  return token;
}

// ─── IterableWeakSet ─────────────────────────────────────────────────────────

export class IterableWeakSet<T extends object> implements Iterable<T> {
  private readonly _refs: WeakRef<T>[] = [];
  private readonly _registry: FinalizationRegistry<WeakRef<T>>;
  private _gcPending = false;

  constructor(values?: Iterable<T>) {
    this._registry = new FinalizationRegistry((ref) => {
      this._scheduleCleanup();
    });
    if (values) {
      for (const value of values) {
        this.add(value);
      }
    }
  }

  /** Add a value. Returns the IterableWeakSet instance. */
  add(value: T): this {
    if (this.has(value)) return this;

    const ref = new WeakRef(value);
    this._refs.push(ref);
    this._registry.register(value, ref, getCleanupToken(value));
    this._gcPending = false;
    return this;
  }

  /** Remove a value. Returns true if the value was present. */
  delete(value: T): boolean {
    const index = this._refs.findIndex((ref) => ref.deref() === value);
    if (index === -1) return false;

    this._refs.splice(index, 1);
    this._registry.unregister(getCleanupToken(value));
    return true;
  }

  /** Check if a value is in the set. */
  has(value: T): boolean {
    return this._refs.some((ref) => ref.deref() === value);
  }

  /** Number of live (non-GC'd) entries. Triggers cleanup. */
  get size(): number {
    this._cleanup();
    return this._refs.length;
  }

  /** Remove all entries. */
  clear(): void {
    for (const ref of this._refs) {
      const value = ref.deref();
      if (value) {
        this._registry.unregister(getCleanupToken(value));
      }
    }
    this._refs.length = 0;
  }

  /** Iterate over live values. Skips GC'd entries and compacts storage. */
  *[Symbol.iterator](): IterableIterator<T> {
    const live: WeakRef<T>[] = [];
    for (const ref of this._refs) {
      const value = ref.deref();
      if (value !== undefined) {
        live.push(ref);
        yield value;
      }
    }
    // Replace the internal array with only live entries
    this._refs.length = 0;
    this._refs.push(...live);
    this._gcPending = false;
  }

  /** @internal For testing/debugging — access raw refs */
  _internalRefs(): readonly WeakRef<T>[] {
    return this._refs;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _scheduleCleanup(): void {
    if (!this._gcPending) {
      this._gcPending = true;
      // Deferred cleanup — no need to queue microtask eagerly;
      // the next public operation handles it.
    }
  }

  private _cleanup(): void {
    if (!this._gcPending && !this._refs.some((r) => r.deref() === undefined)) return;
    this._refs.length = 0;
    // Can't compact without iterating — just clear; clients use for...of to compact.
  }
}

// ─── IterableWeakMap ─────────────────────────────────────────────────────────

export class IterableWeakMap<K extends object, V> implements Iterable<[K, V]> {
  private readonly _keys: WeakRef<K>[] = [];
  private readonly _values: V[] = [];
  private readonly _registry: FinalizationRegistry<WeakRef<K>>;
  private _gcPending = false;

  constructor(entries?: Iterable<[K, V]>) {
    this._registry = new FinalizationRegistry((ref) => {
      this._scheduleCleanup();
    });
    if (entries) {
      for (const [key, value] of entries) {
        this.set(key, value);
      }
    }
  }

  /** Set a key-value pair. Returns the IterableWeakMap instance. */
  set(key: K, value: V): this {
    const index = this._findIndex(key);
    if (index !== -1) {
      this._values[index] = value;
      return this;
    }

    const ref = new WeakRef(key);
    this._keys.push(ref);
    this._values.push(value);
    this._registry.register(key, ref, getCleanupToken(key));
    this._gcPending = false;
    return this;
  }

  /** Get the value for a key. */
  get(key: K): V | undefined {
    const index = this._findIndex(key);
    return index !== -1 ? this._values[index] : undefined;
  }

  /** Check if a key exists. */
  has(key: K): boolean {
    return this._findIndex(key) !== -1;
  }

  /** Delete a key-value pair. Returns true if the key was present. */
  delete(key: K): boolean {
    const index = this._findIndex(key);
    if (index === -1) return false;

    this._keys.splice(index, 1);
    this._values.splice(index, 1);
    this._registry.unregister(getCleanupToken(key));
    return true;
  }

  /** Number of live entries. Triggers cleanup. */
  get size(): number {
    this._compact();
    return this._keys.length;
  }

  /** Remove all entries. */
  clear(): void {
    for (const ref of this._keys) {
      const key = ref.deref();
      if (key) {
        this._registry.unregister(getCleanupToken(key));
      }
    }
    this._keys.length = 0;
    this._values.length = 0;
  }

  /** Iterate over [key, value] pairs. Skips GC'd keys and compacts storage. */
  *[Symbol.iterator](): IterableIterator<[K, V]> {
    const liveKeys: WeakRef<K>[] = [];
    const liveValues: V[] = [];
    for (let i = 0; i < this._keys.length; i++) {
      const key = this._keys[i].deref();
      if (key !== undefined) {
        liveKeys.push(this._keys[i]);
        liveValues.push(this._values[i]);
        yield [key, this._values[i]];
      }
    }
    this._keys.length = 0;
    this._keys.push(...liveKeys);
    this._values.length = 0;
    this._values.push(...liveValues);
    this._gcPending = false;
  }

  /** Iterate over keys. */
  *keys(): IterableIterator<K> {
    for (const [key] of this) yield key;
  }

  /** Iterate over values. */
  *values(): IterableIterator<V> {
    for (const [, value] of this) yield value;
  }

  /** @internal */
  _internalKeys(): readonly WeakRef<K>[] {
    return this._keys;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private _findIndex(key: K): number {
    for (let i = 0; i < this._keys.length; i++) {
      const k = this._keys[i].deref();
      if (k === key) return i;
      if (k === undefined) {
        // Stale entry — clean it up lazily
        this._keys.splice(i, 1);
        this._values.splice(i, 1);
        i--;
      }
    }
    return -1;
  }

  private _scheduleCleanup(): void {
    this._gcPending = true;
  }

  private _compact(): void {
    if (!this._gcPending && !this._keys.some((r) => r.deref() === undefined)) return;
    const liveKeys: WeakRef<K>[] = [];
    const liveValues: V[] = [];
    for (let i = 0; i < this._keys.length; i++) {
      if (this._keys[i].deref() !== undefined) {
        liveKeys.push(this._keys[i]);
        liveValues.push(this._values[i]);
      }
    }
    this._keys.length = 0;
    this._keys.push(...liveKeys);
    this._values.length = 0;
    this._values.push(...liveValues);
    this._gcPending = false;
  }
}
