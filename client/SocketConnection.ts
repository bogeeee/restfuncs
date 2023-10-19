import {Socket} from "engine.io-client";

/**
 * Holds the socket.io (websocket) connection. Shared among all clients (for each different server host)
 */
export class SocketConnection {
    /**
     * Url -> socketconnection
     */
    static instances: Map<string, SocketConnection>

    protected socket?: Socket

    /**
     *
     * @param url
     */
    static getInstance(url: string): SocketConnection {
        let result = this.instances.get(url);
        if(result) {
            return result;
        }

        result = new this;
        this.instances.set(url, result);
        return result;
    }

    constructor() {
    }
}