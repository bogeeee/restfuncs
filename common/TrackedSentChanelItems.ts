export class TrackedSentChannelItems {
    socketConnection: {
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
}