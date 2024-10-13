export class TrackedSentChannelItems {

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
}