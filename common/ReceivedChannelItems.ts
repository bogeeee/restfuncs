import {WeakValueMap} from "./WeakValueMap";
import {
    ChannelItemDTO, Socket_StreamData,
    Socket_StreamDataRequest,
    throwError,
    toHybridReadable,
    validUnless,
    visitReplace
} from "./index";
import {Readable} from "readable-stream";
import nacl_util from "tweetnacl-util"

const DIAGNOSIS_WHATISACHANNELITEM = `channel item (=a stream or callback that was received from the other side)`;

/**
 * Tracks the usage of received channel items. Informs the sender when they are not referenced anymore or closed.
 */
export class ReceivedChannelItems extends WeakValueMap<number, object>{
    socketConnection: {
        isClosed(): boolean;
        sendMessage(message: { type: "channelItemNotUsedAnymore", payload: {id: number, time: number} }): void;
        sendMessage(message: { type: "streamDataRequest", payload: Socket_StreamDataRequest }): void;
        sendMessage(message: { type: "streamData", payload: Socket_StreamData}): void;
        onClose(callback: (reason?: Error) => void): void;
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

    free(item: any) {
        item.id !== undefined && typeof item.id === "number" || throwError(`Value does not seem to be a ${DIAGNOSIS_WHATISACHANNELITEM}`);
        delete(item.id);
        if(!this.socketConnection.isClosed()) {
            this.socketConnection.sendMessage({
                type: "channelItemNotUsedAnymore",
                payload: {id: item.id, time: this.socketConnection.lastReceivedSequenceNumber}
            });
        }
    }

    /**
     * Replaces the DTOs with their real implementations and tracks them here. Supports Readable, Writable s
     * @param receivedValue
     * @param onDTOReplaced: Called back for every replacement. Params: item = the implementation that was inserted (i.e. a Readble). insertIntoPlace = a function that can beused to insert some other object into that place
     */
    replaceDTOsAndTrackThem(receivedValue: unknown, onDTOReplaced?: (item: object, insertIntoPlace: (newValue: unknown)=>void) => void): unknown {
        return visitReplace(receivedValue, (item, visitChilds, context) => {
            const insertIntoPlace = (newValue: unknown) => {
                //@ts-ignore
                context.parentObject[context.key] = newValue;
            }

            if (item !== null && typeof item === "object" && (item as any)._dtoType !== undefined) { // Item is a DTO ?
                let dtoItem: ChannelItemDTO = item as ChannelItemDTO;
                // Validity check:
                if (typeof dtoItem._dtoType !== "string") {
                    throw new Error("_dtoType is not a string");
                }
                const id: number = dtoItem.id;
                if(typeof id !== "number") {
                    throw new Error("id is not a number");
                }

                if(dtoItem._dtoType === "Readable") { // Readable ?
                    const me = this;
                    // Create the readable that reads from the other end
                    let readable = toHybridReadable(new Readable({read(size: number) {
                        me.socketConnection.sendMessage({type: "streamDataRequest", payload: {id, size}});
                    }}));

                    // Handle close:
                    this.socketConnection.onClose((reason) => {
                        readable.destroy(reason)
                    });

                    this.set(id, readable); // Register

                    onDTOReplaced?.(readable, insertIntoPlace);
                    return readable;
                }
                else if(dtoItem._dtoType === "ClientCallback") { // ClientCallback DTO ?
                    return visitChilds(item, context); // Replaced by ServerSocketConnection its self
                }
                else {
                    throw new Error(`Unhandled dto type:${dtoItem._dtoType}`)
                }

            }
            else {
                return visitChilds(item, context)
            }
        });
    }

    handleStreamDataMessage(payload: Socket_StreamData) {

        typeof payload.id === "number" || throwError("Invalid payload"); // Validity check

        const readable = this.get(payload.id) as Readable | undefined;
        if(readable === undefined) {
            throw new Error(`Readable with id ${payload.id} does not exist (anymore)`);
        }
        readable.push( (payload.data !== null && payload.encoding === "buffer")?nacl_util.decodeBase64(payload.data):payload.data, payload.encoding);
    }
}