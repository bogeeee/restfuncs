import {remote, ServerSession, UnknownFunction, isClientCallback, ClientCallback} from "../ServerSession";
import {EventEmitter} from "node:events"
import _ from "underscore"
import {ClientCallbacksCommon, ClientCallbacksOptions} from "./ClientCallbacksCommon";
import {CloseReason, ServerSocketConnection} from "../ServerSocketConnection";

/**
 * Associates client callback functions (usually used as event-listeners) to a certain entity (/item).
 * As the entity parameters, you can either use an object (i.e. a chat room object) or a primitive key (i.e. the chat room's name).
 * The members, including the primitive keys or object associations, get automatically cleaned up, when the client disconnects.
 *   
 * <p>
 * Explanation: Think of it, as that it makes great sense, when you have an excessive amount of database entities, and you don't want to store a collection of ClientCallbacks **on each** of them,
 * just because **eventually** some clients comes and registers a callback on them. This would be a waste of resources, or allow an attacker to exhaust your memory.
 * </p>
 * 
 * <p>
 *     Type parameters:<br/>
 *     - K: the topic/event type. It is totally fine to set this to undefined or just "event", when you are not using it with id-style-topic and also not using it with different event types (cause you want individual EventEmitters per type for more precise type parameters to the listener).
 *     - E: array with the parameters of the callbacks. Hint: They can be named, like in a function declaration. See usage example
 * <p>
 *     Usage example:
 * </p>
 * <pre><code>
 *     TODO: Copy from below
 * </code></pre>
 *
 * <p>
 *     It's not worth noting, that references to object entities are held weak. This doesn't change the behaviour but is more gc friendly.
 * </p>
 *
 */
export class ClientCallbacksForEntities<E, PARAMS extends unknown[]> {

    /**
     * The callbacks, with associations. Type will (lazily) depend on, what's used as an entity.
     * @protected
     */
    protected members?: E extends object?  WeakMap<E,Set<ClientCallback>> : Map<E,Set<ClientCallback>>

    /**
     * TODO: Use an iterable WeakMap in place of the Map
     * @protected
     */
    protected entriesPerClient: WeakMap<ServerSocketConnection, Map<ClientCallback, (E extends object? WeakRef<E>:E)>> = new WeakMap();

    /**
     * Common stuff from both classes.
     * Composition, because the ClientCallbacks class also needs to use it via composition we always use do composition cause protected stuff there must be now public.
     */
    protected common: ClientCallbacksCommon<PARAMS>;

    constructor(options?: ClientCallbacksOptions) {
        this.common = new ClientCallbacksCommon<PARAMS>(options);
    }

    /**
     * Add a callback. It will automatically be removed, if the client disconnects
     * @param entity the entity/key to add it to.
     * @param callback
     */
    add(entity: E, callback: (...args: PARAMS) => unknown) {
        // arguments check:
        this.checkEntityParam(entity);
        const clientCallback = this.common.checkIsValidClientCallback(callback);


        // Lazy initialize this.members:
        if(this.members === undefined) {
            //@ts-ignore
            this.members = (typeof entity === "object") ? new WeakMap() : new Map();
        }

        // Obtain / create set of of all callbacks for the entity
        let callbackSet = this.members.get(entity);
        if(callbackSet === undefined) {
            callbackSet = new Set<ClientCallback>()
            this.members.set(entity, callbackSet);
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
                throw new Error(`The same callback instance was already used for another entity. You must use a unique one for each one. If think, this should be improved, submit an issue in GitHub with a detailed description of your use case.`)
            }
            entriesForThisClient.set(clientCallback, (typeof entity === "object") ? new WeakRef(entity as object) as any : entity);

            // Add to this.members:
            callbackSet.add(clientCallback);
        }
    }

    once(entity: E, listener: (...args: PARAMS) => unknown) {
        // arguments check:
        if(entity === undefined || entity === null) {
            throw new Error("Entity param must not be undefined/null");
        }
        this.common.checkIsValidClientCallback(listener);
        
        this.common.checkIsValidClientCallback(listener);
        throw new Error("TODO")
        return this;
    }

    /**
     * Remove a callback.
     * @param entity the entity/key, where it is removed from.
     * @param callback
     */
    remove(entity: E, callback: (...args: PARAMS) => unknown) {
        // arguments check:
        if(entity === undefined || entity === null) {
            throw new Error("Entity param must not be undefined/null");
        }
        const clientCallback = this.common.checkIsValidClientCallback(callback);

        if(this.members === undefined) {
            return;
        }

        const forEntity = this.members.get(entity);
        if(forEntity) {
            forEntity.delete(clientCallback);
            if(forEntity.size === 0) {
                this.members.delete(entity);
            }

            const entriesForClient = this.entriesPerClient.get(clientCallback.socketConnection);
            entriesForClient!.delete(clientCallback); // also remove here
            if(entriesForClient!.size === 0) { // Was the last one for the client?
                this.entriesPerClient.delete(clientCallback.socketConnection);
            }
        }
    }

    /**
     * Alias for {@link #remove}
     * @param entity
     * @param callback
     */
    delete(entity: E, callback: (...args: PARAMS) => unknown) {
        return this.remove(entity, callback);
    }

    protected getCallbacksFor(entity: E): Set<(...args: PARAMS) => unknown> {
        this.checkEntityParam(entity);

        if(!this.members) {
            return new Set();
        }

        const result = this.members.get(entity);
        if(result === undefined) {
            return new Set();
        }
        return result as Set<any>;
    }

    removeAllForEntity(entity: E) {
        this.getCallbacksFor(entity).forEach(cb => this.delete(entity, cb));
        // Validity check:
        if(this.members?.has(entity)) {
            throw new Error("Assertion failed. Entty key should not exist anymore");
        }
    }

    /**
     * Calls all callbacks for a certain entity/key
     * @param entity
     * @param callArgs
     */
    call(entity: E , ...callArgs: PARAMS) {
        this.common._call(this.getCallbacksFor(entity) as any as Set<ClientCallback>, callArgs);
    }

    /**
     * Calls and waits, till all callbacks have been called and finished successfully. Use, when you rely on the clients, so not on a public web server.
     * @param entity
     * @param callArgs
     */
    async callForSure(entity: E , ...callArgs: PARAMS): Promise<void> {
        return await this.common._callForSure(this.getCallbacksFor(entity) as any as Set<ClientCallback>, callArgs);
    }

    handleServerSocketConnectionClosed(conn: ServerSocketConnection) {
        const entriesMap = this.entriesPerClient.get(conn);
        if(entriesMap) {
            for(const [callback,entityOrRef] of entriesMap.entries()) {
                const entity = entityOrRef instanceof WeakRef?entityOrRef.deref():entityOrRef; // Deref the entity
                this.remove(entity, callback);
            }
        }
    }

    protected checkEntityParam(entity: E) {
        if(entity === undefined) {
            throw new Error("Entity param must not be undefined");
        }
        if(entity === null) {
            throw new Error("Entity param must not be null");
        }
        if(typeof entity === "object") {
            if(this.members !== undefined && !(this.members instanceof WeakMap)) {
                throw new Error("Invalid entity param: Not an object.");
            }
        }
        else {
            if(this.members !== undefined && (this.members instanceof WeakMap)) {
                throw new Error("Invalid entity param: Not a primitive value.");
            }
        }
    }
}

//***** Usage example ******

// Example with id-as-topic style, like you would use it in a web-application with lots of such entities:
type User = {name: string}
const chatJoinCallbacksForRooms = new ClientCallbacksForEntities<string /* the chatroom name */, [user: User] /* the listener function's arguments */>(); // Create a global emitter for all chatrooms
// const chatLeaveCallbacksForRooms = ... // A separate one for each event type. Allows more precise type parameters.
class MyServerSession extends ServerSession{
    currentUser?: User; // Assuming, you'll set this in the login method

    // Expose the .on and .off methods to the client:
    @remote() onJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
        chatJoinCallbacksForRooms.add(chatRoomName, listener);
    }
    @remote() removeJoinChatListener(chatRoomName: string, listener: (joiningUser: User) => void) {
        chatJoinCallbacksForRooms.delete(chatRoomName, listener);
    }

    // Call, when YOU join the chat
    @remote() joinChat(chatRoomName: string) {
        chatJoinCallbacksForRooms.call(chatRoomName, this.currentUser!); // Call the event
    }
}