import {Socket, SocketOptions} from "engine.io-client";
import {isNode, WrappedPromise} from "./Util";
import {RestfuncsClient} from "./index";
import {Socket_Client2ServerMessage, Socket_MethodCallResult, Socket_Server2ClientMessage} from "restfuncs-common";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";

class MethodCallPromise<R> extends WrappedPromise<R> {

}

/**
 * Wraps the socket.io (websocket) connection.
 * Keeps track of multiple method calls and callbacks into that connection
 *
 * Provides static methods so that clients can share a single instance for each url
 *
 */
export class ClientSocketConnection {
    /**
     * Url -> socketconnection
     */
    static instances = new Map<string, Promise<ClientSocketConnection>>()

    static engineIoOptions: Partial<SocketOptions> = {
        transports: isNode?['websocket', 'webtransport']:undefined // Don't use "polling" in node. It does currently does not work in node 21.0.0
    }

    public url!: string;
    public socket!: Socket

    protected callIdGenerator = 0;
    protected methodCallPromises = new Map<Number, MethodCallPromise<unknown>>()

    /**
     *
     * @param url
     * @param initClient The client, that is initially used to fetch the session
     */
    static getInstance(url: string, initClient: RestfuncsClient<any>): Promise<ClientSocketConnection> {
        let result = this.instances.get(url);
        if(result) { // Already created (can be an unresolved promise yet) ?
            return result;
        }

        result = this.New(url, initClient);
        this.instances.set(url, result);

        return result;
    }

    public static async New(url: string, initClient: RestfuncsClient<any>) {
        const result = new this();
        await result.asyncConstructor(url, initClient);
        return result;
    }

    /**
     *
     * @param url url, starting with ws:// or wss://
     * @param initClient The client, that is initially used to fetch the session
     */
    protected async asyncConstructor(url: string, initClient: RestfuncsClient<any>) {
        this.url = url;
        this.socket = new Socket(url, this.clazz.engineIoOptions);

        // Wait until connected and throw an Error on connection errors:
        await new Promise<void>((resolve, reject) => {
            let wasConnected = false;
            this.socket.on('open', () => {
                wasConnected = true;
                this.socket.on('message', (data => {
                    const message = this.deserializeMessage(data);
                    try {
                        this.handleMessage(message as Socket_Server2ClientMessage);
                    }
                    catch (e: any) {
                        this.failFatal(e)
                    }
                }));
                resolve();
            });

            // Handle error events:
            this.socket.on("error", err => {
                if(!wasConnected) {
                    reject(err);
                }
                if(typeof err === "string") {
                    this.failFatal(new Error("Socket error: " + err));
                }
                else {
                    this.failFatal(err);
                }
            })
            this.socket.on("upgradeError", err => {
                if(!wasConnected) {
                    reject(err);
                }
                this.failFatal(err);
            });
            this.socket.on('close', (reason, description) => {
                // Fires, when this.close was called
                //this.failFatal(new Error(reason, {cause: description})); // We must not throw a global error here.
                this.onClose();
            });
        });

        const i = 0;
        // TODO: call "init" which triggers a getHttpCookieSessionAnd... question. Cause we want the session to be synchronized first

    }

    protected failFatal(err: Error ) {
        try {
            this.clazz.instances.delete(this.url); // Unregister instance, so the next client will create a new one
            this.methodCallPromises.forEach(p => p.reject(err)); // Reject outstanding method calls
            if (this.methodCallPromises.size == 0) { // no caller was informed ?
                //throw err; // At least throw that error to the console so you have at least an error somewhere -> nah, this doesn't make sense, that the caller gets an error back / could break things.
            }
        }
        finally {
            this.cleanUp(); // Just to make sure
        }
    }


    private cleanUp() {
        //Dereference resources, just to make sure. We just got a signal that something was wrong but don't know, if the socket is still open -> references this's listeners -> references this / prevents GC
        this.methodCallPromises.clear();
        // TODO: dereference callbacks
        this.socket.removeAllListeners() // With no arg, does this really remove all listeners then ?
    }

    protected onClose() {
        try {
            this.clazz.instances.delete(this.url); // Unregister instance, so the next client will create a new one

            // Reject outstanding method calls:
            const error = new Error("Socket connection has been closed");
            this.methodCallPromises.forEach(p => p.reject(error));
        } finally {
            this.cleanUp(); // Just to make sure
        }
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

    doCall(serverSessionClassId: string, methodName: string, args: any[]): Promise<unknown> {

        const callId = ++this.callIdGenerator;
        const result = new MethodCallPromise();
        this.methodCallPromises.set(callId, result) // Register call

        const message: Socket_Client2ServerMessage = {
            type: "methodCall",
            payload: {
                callId, serverSessionClassId, methodName, args
            }
        }
        this.socket.send(this.serializeMessage(message))

        return result;
    }


    protected deserializeMessage(data: string | Buffer): Socket_Server2ClientMessage {
        if (typeof data !== "string") {
            throw new Error("Data must be of type string");
        }
        return brilloutJsonParse(data) as Socket_Server2ClientMessage;
    }

    protected serializeMessage(message: Socket_Client2ServerMessage): unknown {
        return brilloutJsonStringify(message)
    }

    /**
     *
     * @param message The raw, evil value from the client.
     * @protected
     */
    protected handleMessage(message: Socket_Server2ClientMessage) {
        // Switch on type:
        if(message.type === "methodCallResult") {
            this.handleMethodCallResult(message.payload as Socket_MethodCallResult /* will be validated in method*/)
        }
        else if(message.type === "getVersion") {
            // Leave this for future extensibility / probing feature flags (don't throw an error)
        }
        else {
            throw new Error(`Unhandled message type: ${message.type}`)
        }

    }

    protected handleMethodCallResult(resultFromServer: Socket_MethodCallResult) {
        const methodCallpromise = this.methodCallPromises.get(resultFromServer.callId);
        if(!methodCallpromise) {
            throw new Error( `MethodCallPromise for callId: ${resultFromServer.callId} does not exist.`);
        }

        if(resultFromServer.error) {
            methodCallpromise.reject(resultFromServer.error)
        }
        else {
            methodCallpromise.resolve(resultFromServer.result)
        }
    }
}