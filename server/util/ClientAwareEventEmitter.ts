import {remote, ServerSession, UnknownFunction,isClientCallback} from "../ServerSession";
import {EventEmitter} from "node:events"
import _ from "underscore"

type VoidCallbackFn = (...args: unknown[]) => void

/**
 * Like Node's EventEmitter class (https://nodejs.org/docs/latest-v22.x/api/events.html#class-eventemitter), but it is aware, that the events are client callback functions and therefore
 * listeners and unused event-types/"id-style-topics" will be freed up upon client disconnect.
 * <p>
 * What does "id-style-topic" mean?: You can rather use the event-type as a topic of your liking and store an id there. I.e. use the article number or something where you have an excessive amount of database entities
 * and use the advantage, that topics will be freed up.
 * </p>
 * <p>
 *     Type parameters:<br/>
 *     - T: the topic/event type. It is totally fine to set this to undefined or just "event", when you are not using it with id-style-topic and also not using it with different event types (cause you want individual EventEmitters per type for more precise type parameters to the listener).
 *     - E: array with the parameters of the listeners. Hint: They can be named, like in a function declaration. See usage example
 * <p>
 *     Usage example:
 * </p>
 * <pre><code>
 *     TODO: Copy from below
 * </code></pre>
 *
 */
export class ClientAwareEventEmitter<T, E extends unknown[]> {
    /**
     * Should the {@link #emitForSure} method allow, that a client has (silently) disconnected without calling removeListener ? Otherwise an error is thrown.
     * Enabling this will result in not freeing up unused topics (event-types).
     */
    public readonly emitForSureAllowsDisconnect: boolean | undefined = undefined;

    /**
     * Advanced: Immediately reports to the client that the listeners are not used anymore after the remove.../once... methods. Otherwise this is done after a while after garbage collection.
     * Only enable this, when having trouble with memory consumption on the client and when using the listeners exclusively.
     */
    public freeOnClientImmediately = false;

    /**
     *
     * @param options
     */
    constructor(options?: EventEmitterOptions) {
        if(options) {
            //@ts-ignore
            _.apply(this, options);
        }
    }

    on(type: T, listener: (...eventArgs: E) => any) {
        this.checkIsValidListener(listener);
        throw new Error("TODO")
        return this;
    }

    addListener(type: T, listener: (...eventArgs: E) => any) {
        return this.on(type, listener);
    }

    once(type: T, listener: (...eventArgs: E) => any) {
        this.checkIsValidListener(listener);
        throw new Error("TODO")
        return this;
    }

    removeListener(type: T, listener: (...eventArgs: E) => any) {
        this.checkIsValidListener(listener);
        throw new Error("TODO")
        return this;
    }

    off(type: T, listener: (...eventArgs: E) => any) {
        return this.removeListener(type, listener);
    }

    removeAllListeners() {
        throw new Error("TODO");
        return this;
    }

    emit(eventName: T , ...eventArgs: E): boolean {
        throw new Error("TODO");
    }

    /**
     * Waits, till all listeners have been called and finished. Use, when you rely on the clients, so not on a public web server.
     * @param type
     * @param eventArgs
     */
    async emitForSure(type: T , ...eventArgs: E) {
        // Validity check
        if(this.emitForSureAllowsDisconnect === undefined) {
            throw new Error("When using emitForSure, you must explicitly define the emitForSureAllowsDisconnect parameter in the EventEmitter options. Usually, you'll want to set it to false.");
        }

        // TODO: check that listener.skippable is disabeld
    }

    protected checkIsValidListener(fn: any) {
        if(typeof fn !== "function") {
            throw new Error("The passed argument is not a function.")
        }
        if(!isClientCallback(fn)) {
            throw new Error("The passed argument is not a client callback function.")
        }
    }
}

export type EventEmitterOptions = Partial<Pick<ClientAwareEventEmitter<any, any>, "emitForSureAllowsDisconnect" | "freeOnClientImmediately">>

//***** Usage example ******

// Example with id-as-topic style, like you would use it in a web-application with lots of such entities:
type User = {name: string}
const chatJoinEmitter = new ClientAwareEventEmitter<string /* the chatroom name */, [user: User] /* the listener function's arguments */>(); // Create a global emitter for all chatrooms
// const chatLeaveEmitter = ... // A separate one for each event type. More resource friendly and allows more precise type parameters.
class MyServerSession extends ServerSession{
    currentUser?: User; // Assuming, you'll set this in the login method

    // Expose the .on and .off methods to the client:
    @remote() onJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
        chatJoinEmitter.on(chatRoomName, listener);
    }
    @remote() offJoinChat(chatRoomName: string, listener: (joiningUser: User) => void) {
        chatJoinEmitter.off(chatRoomName, listener);
    }

    // Call, when YOU join the chat
    @remote() joinChat(chatRoomName: string) {
        chatJoinEmitter.emit(chatRoomName, this.currentUser!); // Call the event
    }
}