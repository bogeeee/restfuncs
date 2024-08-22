import {ClientCallbacksSetCommon, ClientCallbackSetOptions} from "./ClientCallbacksSetCommon";
import {ClientCallback} from "../ServerSession";
import {ServerSocketConnection} from "../ServerSocketConnection";

/**
 * A Set of ClientCallback functions which automatically forgets them, when their client disconnects.
 * Use it as a collection/registry for event listeners.
 * Also it as has some convenient features, see {@link #callForSure} and the {@link ClientCallbackSetOptions options} in the constructor.
 * <p>
 * Usage example:
 * </p>
 * <pre><code>
 * type NewsArticle = {title: string, text: string}
 * const newsArticleListeners = new ClientCallbackSet<[newsArticle: NewsArticle]>(); // Create a global event registry/emitter for this event. [newsArticle: NewsArticle] = the listener function's arguments.
 * class MyServerSession extends ServerSession{
 *     // Expose the .on and .off event registering methods to the client:
 *     @remote onNewsArticleCreated(listener: (newsArticle: NewsArticle) => void) {
 *         newsArticleListeners.add(listener);
 *     }
 *     @remote offNewsArticleCreated(listener: (newsArticle: NewsArticle) => void) {
 *         newsArticleListeners.remove(listener);
 *     }
 * }
 *
 * // ... somewhere in your code, when a new news article is created:
 * newsArticleListeners.call(myNewNewsArticle); // Inform the listeners
 * </code></pre>
 */
export class ClientCallbackSet<PARAMS extends unknown[]> extends Set<(...args: PARAMS) => unknown> {

    /**
     * We cannot inherit from ClientCallbacksSetCommon (already inheriting from Set) so we use composition
     */
    common: ClientCallbacksSetCommon<PARAMS>;

    /**
     * TODO: Use an iterable WeakSet in place of the Set
     * @protected
     */
    protected entriesPerClient: WeakMap<ServerSocketConnection, Set<ClientCallback>> = new WeakMap();


    constructor(options?: ClientCallbackSetOptions) {
        super();
        this.common = new ClientCallbacksSetCommon<PARAMS>(options);
    }

    add(callback: (...args: PARAMS) => unknown): this {
        const clientCallback = this.common.checkIsValidClientCallback(callback);

        const socketConnection = clientCallback.socketConnection;
        if(!this.entriesPerClient.has(socketConnection)) { // First time, we are seeing this client ?
            this.entriesPerClient.set(socketConnection, new Set());

            // Register handleServerSocketConnectionClosed listener. TODO: Instead, use the proper socketConnection.onCloseWeak method. This is currently a workaround which has a slight memory footprint.
            const refToThis = new WeakRef(this); // we don't want a strong-ref to `this` in the onclose callback and therefore in the socketconnection !!!
            socketConnection.onClose((reason => {
                const thisInTheFuture = refToThis.deref();
                if(thisInTheFuture !== undefined) { // `this` has not been gc'ed yet ?
                    this.handleServerSocketConnectionClosed(socketConnection);
                }
            }));
        }

        // Check if maxListenersPerClient is reached:
        const entriesForThisClient = this.entriesPerClient.get(socketConnection)!;
        if(this.common.maxListenersPerClient !== undefined && entriesForThisClient.size >= this.common.maxListenersPerClient) {
            throw new Error(`Max listeners per client socket connection reached: ${this.common.maxListenersPerClient}. You can adjust the setting by the 'maxListenersPerClient' option in the constructor if ${this.constructor.name}` );
        }

        entriesForThisClient.add(clientCallback);

        return super.add(callback) as this;
    }

    delete(callback: (...args: PARAMS) => unknown): boolean {
        const clientCallback = this.common.checkIsValidClientCallback(callback);
        const entriesForClient = this.entriesPerClient.get(clientCallback.socketConnection);
        if(entriesForClient !== undefined) {
            entriesForClient.delete(clientCallback);
            if(entriesForClient.size === 0) { // Was the last one for the client?
                this.entriesPerClient.delete(clientCallback.socketConnection);
            }
        }

        return super.delete(callback);
    }

    /**
     * Alias for delete
     * @param callback
     */
    remove(callback: (...args: PARAMS) => unknown): boolean {
        return this.delete(callback);
    }

    /**
     * Calls all callbacks. Does not wait for the result. Ignores disconnects and errors.
     * @param args args which are put into each callback
     */
    call(...args: PARAMS) {
        this.common._call(this as any as Set<ClientCallback>, args);
    }

    /**
     * Waits, till all listeners have been called and finished. Use, when you rely on the clients, so not on a public web server.
     * @param args
     */
    async callForSure(...args: PARAMS): Promise<void> {
        return await this.common._callForSure(this as any as Set<ClientCallback>, args);
    }

    protected handleServerSocketConnectionClosed(conn: ServerSocketConnection) {
        const entriesMap = this.entriesPerClient.get(conn);
        entriesMap?.forEach(cb => this.delete(cb));
    }

}


// Example:
