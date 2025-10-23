export let isNode = false;
if (typeof process === 'object') {
    if (typeof process.versions === 'object') {
        if (typeof process.versions.node !== 'undefined') {
            isNode = true;
        }
    }
}

/**
 * Synchronizes simultaneous operations that they don't get executed twice / unnecessary. While mimicing the failover behaviour of http fetches.
 * If the operation is already running, then subsequent calls will wait for that single result promise. On fail, all will fail.
 * But after such a fail, next exec will do a retry.
 */
export class DropConcurrentOperation<T> {
    resultPromise?: Promise<T>

    /**
     *  See class description
     */
    exec(operation: (() => Promise<T>)): Promise<T> {
        if(this.resultPromise) {
            return this.resultPromise
        }

        return (this.resultPromise = (async () => {
            try {
                return await operation()
            }
            finally {
                this.resultPromise = undefined;
            }
        })());
    }

    /**
     * Next executor will try again
     */
    fail() {
        this.resultPromise = undefined;
    }

    /**
     * ..., does not care if the the promise succeeded or errored
     */
    async waitTilIdle() {
        if(this.resultPromise) {
            try {
                await this.resultPromise
            }
            catch (e) {
                // The other "thread" cares about catching errors. We don't care
            }
        }
    }

    expectIdle() {
        if(this.resultPromise !== undefined) {
            throw new Error("Operation is not idle");
        }
    }
}

/**
 * like {@see DropConcurrentOperation} but it stores a map of multiple operations
 */
export class DropConcurrentOperationMap<K, T> {
    resultPromises = new Map<K, Promise<T>>()

    /**
     *  See class description
     */
    exec(key: K, operation: (() => Promise<T>)): Promise<T> {
        const existing = this.resultPromises.get(key);
        if(existing) {
            return existing;
        }

        const resultPromise = (async () => {
            try {
                return await operation()
            }
            catch (e) {
                this.fail(key) // Next one will try again
                throw e;
            }
        })();

        this.resultPromises.set(key, resultPromise);
        return resultPromise;
    }

    /**
     * Next executor will try again
     */
    fail(key: K) {
        this.resultPromises.delete(key);
    }

    /**
     * Waits for aöö outstanding results. Ignores failed
     */
    async getAllSucceeded(): Promise<T[]> {
        const result = []
        for(const promise of this.resultPromises.values()) {
            try {
                // @ts-ignore TS2345: Don't know why. This comes only when build is run with a ts-patch transformProgram transformer
                result.push(await promise);
            }
            catch (e) {
                // No throw. Not our concern if connection failed to initialize
            }
        }
        return result;
    }
}

/**
 * Concurrent and later exec calls will wait for that single promise to be resolved.
 * On a fail, the next exec call will try again.
 */
export class RetryableResolver<T> {
    resultPromise?: Promise<T>;

    /**
     * Concurrent and later exec calls will wait for that single promise to be resolved.
     * On a fail, the next exec call will try again.
     * @param resolver
     */
    exec(resolver: (() => Promise<T>)): Promise<T> {
        if (this.resultPromise === undefined) {
            return this.resultPromise = (async () => {
                try {
                    return await resolver();
                } catch (e) {
                    this.resultPromise = undefined; // Let the next one try again
                    throw e;
                }
            })()
        }
        return this.resultPromise;
    }
}

/**
 * Like the name says. Also if an old operation errors, this will be ignored
 */
class LatestGreatestOperation<T> {
    protected latestPromise?: Promise<T>

    /**
     *  See class description
     *  @return result from `operation` or a later operation
     */
    exec(operation: ((isOutdated?: () => boolean) => Promise<T>)): Promise<T> {
        let operationsPromise: Promise<T> | undefined
        const isOutdated = () => {
            return operationsPromise !== undefined && operationsPromise !== this.latestPromise;
        }

        this.latestPromise = operationsPromise = (async () => {
            const result = operation(isOutdated);
            if(!isOutdated()) {
                this.latestPromise = undefined; // Mark finished
            }
            return result; // Exec operation
        })()

        return this.getLatest() as Promise<T>
    }

    /**
     * ..., does not care if the the promise succeeded or errored
     */
    async waitTilIdle() {
        while(this.latestPromise) {
            try {
                await this.latestPromise
            }
            catch (e) {
                // The other "thread" cares about catching errors. We don't care
            }
        }
    }

    /**
     * Waits till the latest operation has finished. Will return undefined if no operations is currently running
     */
    async getLatest(): Promise<T | undefined> {
        let result
        while(this.latestPromise) {
            try {
                result = await this.latestPromise;
            }
            catch (e) {
                if(!this.latestPromise) { // finished ?
                    throw e;
                }
            }
        }
        return result;
    }
}

export function throwError(e: string | Error) {
    if(e !== null && e instanceof Error) {
        throw e;
    }
    throw new Error(e);
}

/**
 * A Map<K, Set<V>>. But automatically add a new Set if needed
 */
export class MapSet<K, V> {
    map = new Map<K, Set<V>>()

    add(key: K, value: V) {
        let set = this.map.get(key);
        if(set === undefined) {
            set = new Set<V>();
            this.map.set(key, set);
        }
        set.add(value);
    }

    delete(key: K, value: V) {
        let set = this.map.get(key);
        if(set !== undefined) {
            set.delete(value);
            if(set.size === 0) {
                this.map.delete(key); // Clean up
            }
        }
    }

    get(key: K) {
        return this.map.get(key);
    }

    /**
     * @param key
     * @return the set for the specified key (an empty one will be created if needed) on which you should call `add` or `delete` **immediately**, so no empty set is left there consuming memory.
     * It is automatically cleaned up after the last delete
     */
    get4use(key: K) {
        const thisMapSet = this;
        let set = this.map.get(key);
        if(set === undefined) {
            set = new class extends Set<V>{
                delete(value: V): boolean {
                    const result = super.delete(value);
                    if(this.size === 0) {
                        thisMapSet.map.delete(key); // Clean up
                    }
                    return result;
                }
                add(value: V): this {
                    if(thisMapSet.map.get(key) !== this) {
                        throw new Error("This set is invalid. You must add/delete immediately after calling get4modify")
                    }
                    return super.add(value);
                }
            };
            this.map.set(key, set);
        }
        return set;
    }
}

/**
 * This Map does not return empty values, so there's always a default value created
 */
export abstract class DefaultMap<K, V> extends Map<K,V>{
    abstract createDefaultValue(): V;

    get(key: K): V {
        let result = super.get(key);
        if(result === undefined) {
            result = this.createDefaultValue();
            this.set(key, result);
        }
        return result;
    }
}

/**
 *
 * @param createDefaultValueFn
 * @returns a Map that creates and inserts a default value when that value does not exist. So the #get method always returns something.
 */
export function newDefaultMap<K,V>(createDefaultValueFn: () => V): DefaultMap<K, V> {
    return new class extends DefaultMap<K, V> {
        createDefaultValue(): V {
            return createDefaultValueFn();
        }
    }()
}

/**
 * A WeakMap<K, Set<V>>. But automatically add a new Set if needed
 */
export class WeakMapSet<K extends object, V> extends MapSet<K, V> {
    map = new WeakMap<K, Set<V>>() as Map<K, Set<V>>;
}