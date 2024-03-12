import {ClientCallback, remote, ServerSession} from "./ServerSession";
import {ServerSocketConnection} from "./ServerSocketConnection";

/**
 * Concept
 */
export class StableSubscriptions<KEY, CALLBACK extends (...args: any) => any> {

    // Properties:
    name: string;
    options: {
        /**
         * Default: false
         */
        skipOutdated?: boolean

        /**
         * In case a client has missed some events during a disconnect phase, the client can still keep up.
         * Default: 0
         */
        keepLast?: number
    }

    // State:
    subscribers = new Map<KEY, {
        clientCallbacks: {conn: ServerSocketConnection, callbackId: number}[]
    }>()

    /**
     * In case a client has missed some events, it can reorder them
     * TODO: use a versoin number
     */
    lastEvents: Parameters<CALLBACK>[] = []; // TODO: fifo buffer


    constructor(name: string, options: {} = {}) {
        this.name = name;
        this.options = options;
        // TODO: register on restfuncs server
    }

    subscribe(key: KEY, callback: CALLBACK) {
        // TODO: Check if it is a client callback
        //(callback as ClientCallback).socketConnection.sendSubscribeToken()
        //this.subscribers.get(key)...
    }

    unsubscribe(key: KEY, callback: CALLBACK) {
        //(callback as ClientCallback).socketConnection.sendUnSubscribeToken()
    }

    fireEvent(key: KEY): CALLBACK {
        throw new Error("TODO")
    }

}

/*

// Usage:
const myChatroomSubscriptions = new StableSubscriptions<string, (chatMessage: string) => void>("chatMessage")
class MyServerSession extends ServerSession {
    @remote()
    subscribeToChat(chatRoomName: string, callback: (chatMessage: string) => void) {
        myChatroomSubscriptions.subscribe(chatRoomName, callback)
    }
}

// On a chat message event:
myChatroomSubscriptions.fireEvent("myChatRoom")("Hello !");

*/