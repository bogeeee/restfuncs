import {remote, ServerSession, UnknownFunction, isClientCallback, ClientCallback, free} from "../ServerSession";
import _ from "underscore"
import {ClientCallbacksSetCommon, ClientCallbackSetOptions} from "./ClientCallbacksSetCommon";
import {CloseReason, ServerSocketConnection} from "../ServerSocketConnection";

/**
 * Associates client callback functions (usually used as event-listeners) to a certain item.
 * As the item parameters, you can either use an object (i.e. a chat room object) or a primitive key (i.e. the chat room's name).
 * The members, including the primitive keys or object associations, get automatically cleaned up, when the client disconnects.
 *   
 * <p>
 * Explanation: Think of it, as that it makes great sense, when you have an excessive amount of database entities, and you don't want to store a ClientCallbackSet **on each** of them,
 * just because **eventually** some clients comes and registers a callback on them. This would be a waste of resources, or allow an attacker to exhaust your memory.
 * </p>
 * 
 * <p>
 *     Type parameters:<br/>
 *     - ITEM: The item. Either your item type, or string of you want to use string keys.
 *     - PARAMS: array with the parameters of the callbacks. Hint: They can be named, like in a function declaration. See usage example
 * </p>
 * <p>
 *     Usage example:
 * </p>
 * <pre><code>
 * type User = {name: string}
 * const chatJoinListenersForRooms = new ClientCallbackSetPerItem<string, [user: User]>(); // Create a global event registry/emitter for all chat rooms. string = the chatroom name, [user: User] = the listener function's arguments.
 * // const chatLeaveCallbacksForRooms = ... // A separate one for each event type. Allows more precise type parameters.
 * class MyServerSession extends ServerSession{
 *     currentUser?: User; // Assuming, you'll set this in the login method
 *
 *     // Expose the .on and .off event registering methods to the client:
 *     @remote onJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
 *         chatJoinListenersForRooms.add(chatRoomName, listener);
 *     }
 *     @remote offJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
 *         chatJoinListenersForRooms.delete(chatRoomName, listener);
 *     }
 *
 *     // Call, when YOU join the chat
 *     @remote joinChat(chatRoomName: string) {
 *         chatJoinListenersForRooms.call(chatRoomName, this.currentUser!); // Call the event / inform all listeners
 *     }
 * }
 * </code></pre>
 *
 * <p>
 *     It's not worth noting, that references to object entities are held weak. This doesn't change the behaviour but is more gc friendly.
 * </p>
 * <p>
 *     Note also: It says ClientCallback but more precisely this class accepts more general {@link SocketAssociatedCallbackFunction}s
 * </p>
 *
 */
export class ClientCallbackSetPerItem<ITEM, PARAMS extends unknown[]> {

    /**
     * The callbacks, with associations. Type will (lazily) depend on, what's used as an item.
     * @protected
     */
    protected members?: ITEM extends object?  WeakMap<ITEM,Set<ClientCallback>> : Map<ITEM,Set<ClientCallback>>

    /**
     * TODO: Use an iterable WeakMap in place of the Map
     * @protected
     */
    protected entriesPerClient: WeakMap<ServerSocketConnection, Map<ClientCallback, (ITEM extends object? WeakRef<ITEM>:ITEM)>> = new WeakMap();

    /**
     * Common stuff from both classes.
     * Composition, because the ClientCallbackSet class also needs to use it via composition we always use do composition cause protected stuff there must be now public.
     */
    protected common: ClientCallbacksSetCommon<PARAMS>;

    constructor(options?: ClientCallbackSetOptions) {
        this.common = new ClientCallbacksSetCommon<PARAMS>(options);
    }

    /**
     * Add a callback. It will automatically be removed, if the client disconnects
     * @param item the item/key to add it to.
     * @param callback
     */
    add(item: ITEM, callback: (...args: PARAMS) => unknown) {
        // arguments check:
        this.checkItemParam(item);
        const clientCallback = this.common.checkIsSocketAssociatedCallbackFunction(callback);


        // Lazy initialize this.members:
        if(this.members === undefined) {
            //@ts-ignore
            this.members = (typeof item === "object") ? new WeakMap() : new Map();
        }

        // Obtain / create set of of all callbacks for the item
        let callbackSet = this.members.get(item);
        if(callbackSet === undefined) {
            callbackSet = new Set<ClientCallback>()
            this.members.set(item, callbackSet);
        }

        if(!callbackSet.has(clientCallback)) { // is new ?
            const socketConnection = clientCallback.socketConnection;
            if(!this.entriesPerClient.has(socketConnection)) { // First time, we are seeing this client ?
                this.entriesPerClient.set(socketConnection, new Map());

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

            // Add to this.entriesPerClient:
            if(entriesForThisClient.has(clientCallback)) {
                throw new Error(`The same callback instance was already used for another item. You must use a unique one for each one. If you think, this should be improved, submit an issue in GitHub with a detailed description of your use case.`)
            }
            entriesForThisClient.set(clientCallback, (typeof item === "object") ? new WeakRef(item as object) as any : item);

            // Add to this.members:
            callbackSet.add(clientCallback);
        }
    }

    /**
     * Remove a callback.
     * @param item the item/key, where it is removed from.
     * @param callback
     */
    remove(item: ITEM, callback: (...args: PARAMS) => unknown) {
        // arguments check:
        if(item === undefined || item === null) {
            throw new Error("Item param must not be undefined/null");
        }
        const clientCallback = this.common.checkIsSocketAssociatedCallbackFunction(callback);

        if(this.members !== undefined) {
            const forItem = this.members.get(item);
            if (forItem) {
                forItem.delete(clientCallback);
                if (forItem.size === 0) {
                    this.members.delete(item);
                }

                const entriesForClient = this.entriesPerClient.get(clientCallback.socketConnection);
                entriesForClient!.delete(clientCallback); // also remove here
                if (entriesForClient!.size === 0) { // Was the last one for the client?
                    this.entriesPerClient.delete(clientCallback.socketConnection);
                }
            }
        }

        if(this.common.freeOnClientImmediately) {
            free(callback);
        }
    }

    /**
     * Alias for {@link #remove}
     * @param item
     * @param callback
     */
    delete(item: ITEM, callback: (...args: PARAMS) => unknown) {
        return this.remove(item, callback);
    }

    public getCallbacksFor(item: ITEM): Set<(...args: PARAMS) => unknown> {
        this.checkItemParam(item);

        if(!this.members) {
            return new Set();
        }

        const result = this.members.get(item);
        if(result === undefined) {
            return new Set();
        }
        return result as Set<any>;
    }

    removeAllForItem(item: ITEM) {
        this.getCallbacksFor(item).forEach(cb => this.delete(item, cb));
        // Validity check:
        if(this.members?.has(item)) {
            throw new Error("Assertion failed. Item should not exist anymore");
        }
    }

    /**
     * Calls all callbacks for the specified item/key.
     * <p>
     * Does not wait for the result. Ignores disconnects and errors.
     * </p>
     * @param item
     * @param callArgs
     */
    call(item: ITEM , ...callArgs: PARAMS) {
        this.common._call(this.getCallbacksFor(item) as any as Set<ClientCallback>, callArgs);
    }

    /**
     * Calls and waits, till all callbacks have been called and finished successfully. Use, when you rely on the clients, so not on a public web server.
     * @param item
     * @param callArgs
     */
    async callForSure(item: ITEM , ...callArgs: PARAMS): Promise<void> {
        return await this.common._callForSure(this.getCallbacksFor(item) as any as Set<ClientCallback>, callArgs);
    }

    protected handleServerSocketConnectionClosed(conn: ServerSocketConnection) {
        if(this.common.removeOnDisconnect === false) {
            return;
        }

        const entriesMap = this.entriesPerClient.get(conn);
        if(entriesMap) {
            for(const [callback,keyOrItemRef] of entriesMap.entries()) {
                const item = keyOrItemRef instanceof WeakRef?keyOrItemRef.deref():keyOrItemRef; // Deref the item
                this.remove(item, callback);
            }
        }
    }

    protected checkItemParam(item: ITEM) {
        if(item === undefined) {
            throw new Error("Item param must not be undefined");
        }
        if(item === null) {
            throw new Error("Item param must not be null");
        }
        if(typeof item === "object") {
            if(this.members !== undefined && !(this.members instanceof WeakMap)) {
                throw new Error("Invalid item param: Not an object.");
            }
        }
        else {
            if(this.members !== undefined && (this.members instanceof WeakMap)) {
                throw new Error("Invalid item param: Not a primitive value.");
            }
        }
    }
}

//***** Usage example ******

