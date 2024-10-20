import {Readable, Writable} from "readable-stream";
import {
    ChannelItemDTO,
    isAnyReadableStream,
    Socket_StreamData,
    Socket_StreamDataRequest,
    toHybridReadable,
    visitReplace
} from "./index";
import {isReadable} from "./hybridstreams";
import nacl_util from "tweetnacl-util"

export class TrackedSentChannelItems {
    socketConnection: {
        //sendMessage(message: { type: "streamDataRequest", payload: Socket_StreamDataRequest }): void;
        sendMessage(message: { type: "streamData", payload: Socket_StreamData}): void;
        onClose(callback: (reason?: Error) => void): void;
        lastSentMessageSequenceNumber: number
    }
    constructor(sc: TrackedSentChannelItems["socketConnection"]) {
        this.socketConnection = sc;
    }

    protected dtoIdGenerator = 0;

    /**
     * Channel items that were sent to the other side and are currently there
     */
    items = new Map<number, {
        item: object,
        /**
         * The sequenceNumber **before** last sent to the remote side
         */
        lastTimeSent: number
    }>()

    readRequestCallbacks = new WeakMap<Readable, (error?: (Error | null)) => void>()


    /**
     * Adds an id to an (already used) item
     */
    itemIds = new WeakMap<object, number>();

    /**
     * Creates one if if needed
     * @param item
     */
    getItemId(item: object) {
        const existingId = this.itemIds.get(item);
        if(existingId !== undefined) {
            return existingId;
        }

        const newId = this.dtoIdGenerator++;
        this.itemIds.set(item, newId);
        return newId;
    }

    /**
     * Creates one if if needed
     * @param item
     */
    registerItemBeforeSending(item: object) {
        const id = this.getItemId(item);
        this.items.set(id, {item, lastTimeSent: this.socketConnection.lastSentMessageSequenceNumber});
        return id;
    }

    /**
     * Replaces all ClientCallback DTOs in the arguments with "_callback_XXX" placeholders and registers swapper functions for them, which bring them to life
     * The placeholder+swapping functions is a preparation for {@link ServerSession#validateMethodArguments}.
     */
    replaceStreamChannelItemsWithDTOs(valueToBeSent: unknown): unknown {
        return visitReplace(valueToBeSent, (item, visitChilds, context) => {
            if (isAnyReadableStream(item)) {
                const me = this;
                const readableItem: Readable = toHybridReadable(item as any);
                const itemId = this.registerItemBeforeSending(readableItem);
                const result: ChannelItemDTO = {
                    id: itemId,
                    _dtoType: "Readable"
                }

                // Create a writeable to catch the data and send it:
                const writable = new Writable({write(chunk: any, encoding: BufferEncoding | string, callback: (error?: (Error | null)) => void) {
                        const payload: Socket_StreamData = {
                            id: itemId,
                            encoding,
                            data: (encoding === "buffer" && chunk !== null)?nacl_util.encodeBase64(chunk):chunk
                        }
                        me.socketConnection.sendMessage({type: "streamData", payload});

                        me.readRequestCallbacks.set(readableItem, callback);
                }});
                writable.on("finish", () => { // Note: for the readable-streams package, only the "finish" event is fired. Not also the "close" event
                    me.socketConnection.sendMessage({type: "streamData", payload: { id: itemId, data: null, encoding: ""}});
                });
                readableItem.pipe(writable);

                // Handle close:
                this.socketConnection.onClose((reason) => {
                    readableItem.destroy(reason);
                });

                return result;
            }
            else {
                return visitChilds(item, context)
            }
        });
    }
}