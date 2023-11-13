export let isNode = false;
if (typeof process === 'object') {
    if (typeof process.versions === 'object') {
        if (typeof process.versions.node !== 'undefined') {
            isNode = true;
        }
    }
}

/**
 * Exposes the resolve and reject methods to the outside
 */
export class ExternalPromise<T> implements Promise<T>{
    private promise: Promise<T>;
    resolve!: (value: T | PromiseLike<T>) => void;
    reject!: (reason?: any) => void;

    constructor() {

        this.promise = new Promise<T>((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }

    then<TResult1 = T, TResult2 = never>(
        onFulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
    ): Promise<TResult1 | TResult2> {
        return this.promise.then(onFulfilled, onRejected);
    }

    catch<TResult = never>(
        onRejected?: ((reason: any) => TResult | PromiseLike<TResult>) | null
    ): Promise<T | TResult> {
        return this.promise.catch(onRejected);
    }

    finally(onFinally?: (() => void) | null): Promise<T> {
        return this.promise.finally(onFinally);
    }

    readonly [Symbol.toStringTag]: string = "WrappedPromise"; // Must offer this when implementing Promise. Hopefully this is a proper value
}

/**
 * Synchronizes simultaneous operations that they don't get executed twice / unnecessary. While mimicing the failover behaviour of http fetches.
 * If the operation is already running, then succeeding calls will wait for that single result promise. On fail, all will fail.
 * But after such a fail, next exec will do a retry.
 */
export class SingleRetryableOperation<T> {
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
 * like {@see SingleRetryableOperation} but it stores a map of multiple operations
 */
export class SingleRetryableOperationMap<K, T> {
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