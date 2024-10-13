import {WeakValueMap} from "./WeakValueMap";

export abstract class ChannelItemsReceiver {
    /**
     * Must be tracked by the implementer
     */
    lastSequenceNumberFromClient=-1;

    protected abstract isClosed(): boolean;
    protected abstract sendMessage(message: { type: "channelItemNotUsedAnymore", payload: {id: number, time: number} }): void;

    /**
     * id -> channel item
     */
    channelItems = new WeakValueMap<number, object>([], (id) => {
        if(!this.isClosed()) {
            this.sendMessage({ type: "channelItemNotUsedAnymore", payload: {id, time: this.lastSequenceNumberFromClient} }); // Inform the client that the callback is not referenced anymore
        }
    });
}