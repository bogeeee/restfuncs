/**
 * A map with strong keys and weak values where the entries (=both, key + value) get cleaned up when the value has been garbage collected.
 *
 * <p>
 * As an extra feature it also accepts functions as values which are normally not trackable by the FinalizationRegistry. Those get wrapped in a peer object as a workaround.
 * </p>
 */
export class WeakValueMap<K, V extends Object> implements Map<K, V> {
    protected storage = new Map<K, WeakRef<Trackable<V>>>();

    protected registry = new FinalizationRegistry ((key: K) => {
        this.handleLost(key);
    });

    /**
     * Called when an entry was lost because it was garbage collected.
     * Note that an explicit call to {@link #delete} or {@link #clear} won't trigger this.
     */
    public entryLostCallback?: (key: K) => void;

    /**
     *
     * @param entries initial entries as array of [key, value] pairs
     * @param entryLostCallback See {@link #entryLostCallback}
     */
    constructor(entries: [K,V][] = [], entryLostCallback?: (key: K) => void) {
        for (const [key, value] of entries) {
            this.set(key, value);
        }

        this.entryLostCallback = entryLostCallback;
    }

    get size(): number {
        return [...this].length;
    }

    /**
     * Clears all entries but does not call the entryLostCallbacks
     */
    clear() {
        this.storage.clear();
    }

    /**
     * Deletes the entry but does not call the entryLostCallback
     * @param key
     */
    delete(key: K) {
        return this.storage.delete(key);
    }

    private handleLost(key: K) {
        let weakRef = this.storage.get(key);
        if(weakRef === undefined) { // Entry does not exist at all ?
            return;
        }

        if(weakRef.deref() === undefined) { // Just lost the entry ?
            this.storage.delete(key);
            this.entryLostCallback?.(key);
        }
    }

    get(key: K) {
        let weakRef = this.storage.get(key);
        if(weakRef === undefined) {
            return undefined;
        }

        let tValue = weakRef.deref();
        if(tValue === undefined) { // Just lost it ?
            this.handleLost(key);
            return undefined;
        }
        return this.trackableToValue(tValue);
    }

    /**
     * Like get, but does not trigger cleanup or the entryLostCallback.
     * @param key
     */
    peek(key: K) {
        const tValue  = this.storage.get(key)?.deref();
        if(tValue === undefined) {
            return undefined;
        }
        return this.trackableToValue(tValue);
    }

    has(key: K) {
        let weakRef = this.storage.get(key);
        if(weakRef === undefined) {
            return false;
        }

        let tValue = weakRef.deref();
        if(tValue === undefined) {
            this.handleLost(key);
            return false;
        }
        return true;
    }

    set(key: K, value: V) {
        if(value === undefined) {
            throw new Error("Value must not be undefined");
        }

        let tValue = this.valueToTrackable(value);
        this.storage.set(key, new WeakRef(tValue));
        this.registry.register(tValue, key);
        return this;
    }

    forEach(callbackfn: (value: V, key: K, map: Map<K, V>) => void, thisArg?: any) {
        throw new Error("Iterator functions are not yet implemented")
    }

    [Symbol.iterator](): IterableIterator<[K, V]> {
        throw new Error("Iterator functions are not yet implemented")
    }


    entries(): IterableIterator<[K, V]> {
        throw new Error("Iterator functions are not yet implemented")
    }

    keys(): IterableIterator<K> {
        throw new Error("Iterator functions are not yet implemented")
    }

    values(): IterableIterator<V> {
        throw new Error("Iterator functions are not yet implemented")
    }

    get [Symbol.toStringTag]() {
        return this.storage[Symbol.toStringTag]
    }

    // ******************************************************
    // **** Section: Fields and functions for trackables ****
    // Some object types (functions) are not trackable, so we use a peer object. Only in that case but we pretend we always use the Trackable for better type safety.
    // ******************************************************
    valueToTrackableMap = new WeakMap<V, Trackable<V>>();

    valueToTrackable(value: V): Trackable<V> {
        if(typeof value === "function") { // value cannot by tracked by gc ?
            //value must be wrapped in Trackable:

            let existing = this.valueToTrackableMap.get(value);
            if(existing) {
                return existing;
            }

            const trackable = {
                __isTrackable:true,
                __value: value,
            } as Trackable<V>
            this.valueToTrackableMap.set(value, trackable);

            return trackable;
        }
        else if(typeof value === "object") {
            return value as any as Trackable<V>; // no need to wrap
        }
        else {
            throw new Error("Cannot store non-objects as values in WeakValueMap");
        }
    }

    trackableToValue(trackable: Trackable<V>): V {
        if(trackable.__isTrackable) {
            return trackable.__value;
        }
        else {
            return trackable as any as V; // no need to unwrap
        }
    }


}


/**
 * Pseudo-type to flag it as trackable
 */
type Trackable<V> = {
    __isTrackable: true;
    __value: V;
}