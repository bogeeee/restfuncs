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