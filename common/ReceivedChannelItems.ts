import {WeakValueMap} from "./WeakValueMap";

/**
 * Tracks the usage of received channel items. Informs the sender when they are not referenced anymore or closed.
 */
export class ReceivedChannelItems extends WeakValueMap<number, object>{
    socketConnection: {
        isClosed(): boolean;
        sendMessage(message: { type: "channelItemNotUsedAnymore", payload: {id: number, time: number} }): void;
        /**
         * Must be tracked by the implementer
         */
        lastReceivedSequenceNumber: number
    }

    constructor(sc: ReceivedChannelItems["socketConnection"]) {
        super([], (id) => {
            if(!this.socketConnection.isClosed()) {
                this.socketConnection.sendMessage({ type: "channelItemNotUsedAnymore", payload: {id, time: this.socketConnection.lastReceivedSequenceNumber} }); // Inform the client that the callback is not referenced anymore
            }
        });
        this.socketConnection = sc;
    }
}