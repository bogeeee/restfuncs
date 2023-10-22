import {Socket, SocketOptions} from "engine.io-client";
import {isNode} from "./Util";

/**
 * Holds the socket.io (websocket) connection. Shared among all clients (for each different server host)
 */
export class ClientSocketConnection {
    /**
     * Url -> socketconnection
     */
    static instances = new Map<string, ClientSocketConnection>()

    static engineIoOptions: Partial<SocketOptions> = {
        transports: isNode?['websocket', 'webtransport']:undefined // Don't use "polling" in node. It does currently does not work in node 21.0.0
    }

    public socket!: Socket

    /**
     *
     * @param url
     */
    static async getInstance(url: string): Promise<ClientSocketConnection> {
        let result = this.instances.get(url);
        if(result) { // Already created ?
            return result;
        }

        result = await this.New(url);
        this.instances.set(url, result);
        return result;
    }

    /**
     *
     * @param url url, starting with ws:// or wss://
     */
    protected async asyncConstructor(url: string) {
        this.socket = new Socket(url, this.clazz.engineIoOptions);

        // Wait until connected and throw an Error on connection errors:
        await new Promise<void>((resolve, reject) => {
            let wasConnected = false;
            this.socket.on('open', () => {
                wasConnected = true;
                resolve();
            });
            this.socket.on("error", err => {
                if(!wasConnected) {
                    reject(err);
                }
                else {
                    throw err;
                }
            })
            this.socket.on("upgradeError", err => {
                if(!wasConnected) {
                    reject(err);
                }
                else {
                    throw err;
                }
            });
        });

        const i = 0;

    }

    public static async New(url: string) {
        const result = new this();
        await result.asyncConstructor(url);
        return result;
    }

    public close() {
        this.socket.close();
    }


    /**
     * <p/>
     * In order to make your special static subclass members available via <code>this.clazz</code>, you must help typescript a bit by redefining this field with the follwing line:
     * </p>
     * <pre><code>
     *     classType!: typeof YOUR-SUBCLASS;
     * </code></pre>
     */
    classType!: typeof ClientSocketConnection

    /**
     * Helper, to access static members from a non-static context.
     * <p>
     * In order to make your special static subclass members available, you must help typescript a bit by redefining the <code>classType</code> field with the follwing line:
     * </p>
     * <pre><code>
     *     classType!: typeof YOUR-SUBCLASS;
     * </code></pre>
     */
    get clazz(): this["classType"] {
        // @ts-ignore
        return this.constructor
    }
}