import {Socket, SocketOptions} from "engine.io-client";
import {isNode, ExternalPromise, SingleRetryableOperationMap, SingleRetryableOperation} from "./Util";
import {RestfuncsClient, ServerError} from "./index";
import {
    IServerSession,
    Socket_Client2ServerMessage,
    Socket_MethodCallResult, Socket_Server2ClientInit,
    Socket_Server2ClientMessage
} from "restfuncs-common";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";

class MethodCallPromise extends ExternalPromise<Socket_MethodCallResult> {

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
     * Url -> ClientSocketConnection
     */
    static instances = new SingleRetryableOperationMap<string, ClientSocketConnection>()

    static engineIoOptions: Partial<SocketOptions> = {
        transports: isNode?['websocket', 'webtransport']:undefined // Don't use "polling" in node. It does currently does not work in node 21.0.0
    }

    public url!: string;
    public socket!: Socket

    /**
     * Send from the server after connection
     * @protected
     */
    protected initMessage = new ExternalPromise<Socket_Server2ClientInit>()

    protected callIdGenerator = 0;
    protected methodCallPromises = new Map<Number, MethodCallPromise>()

    protected fetchInitialSessionOp = new SingleRetryableOperation<void>()

    /**
     * Whether the process of fetching (from http) and update the session is currently running. So we won't start it twice
     * @protected
     */
    protected fetchSessionOp = new SingleRetryableOperation<void>()

    /**
     *  update to http side and fetch the latest session from there and install it on the websocket connection.
     *  Or, if it was triggered by a session change on the http side, just update to the websocket connection
     */
    protected cookieSessionSyncOp = new SingleRetryableOperation<void>()  // TODO: LatestGreatestOperation

    /**
     * Whether the process of fetching the getHttpCookieSessionAndSecurityProperties is currently running, so we won't start it twice.
     * The key is either the security group id or ServerSession id, depending on what's the server's preference. See Socket_MethodCallResult#needsHttpSecurityProperties#syncKey
     * @protected
     */
    protected fetchHttpSecurityPropertiesOp  = new SingleRetryableOperationMap<string, void>()

    /**
     * Whether this connection failed. When set, you must create a new ClientSocketConnection.
     */
    public fatalError?: Error

    protected usedByClients = new Set<RestfuncsClient<any>>()

    /**
     *
     * @param url
     * @param client Will be registered so that this connection can be closed, when no more client owns it.
     */
    static async getInstance(url: string, client: RestfuncsClient<any>): Promise<ClientSocketConnection> {
        const result = await this.instances.exec(url, async () => {
            return this.New(url, client);
        });

        result.usedByClients.add(client); // Register client

        return result
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
    protected async asyncConstructor(url: string, initClient: RestfuncsClient<IServerSession>) {
        this.url = url;
        this.socket = new Socket(url, this.clazz.engineIoOptions);

        // Wait until connected and throw an Error on connection errors:
        await new Promise<void>((resolve, reject) => {
            let wasConnected = false;
            this.socket.on('open', () => {
                wasConnected = true;
                this.socket.on('message', (data => {
                    try {
                        const message = this.deserializeMessage(data);
                        this.handleMessage(message as Socket_Server2ClientMessage);
                    }
                    catch (e: any) {
                        this.failFatal(typeof data === "string" && data.startsWith("[Error]") ? data : e)
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

        // Initialize the cookieSession
        const initMessage = await this.initMessage; // Wait till the server has sent us that message
        const getCookieSession_answer = await initClient.controlProxy_http.getCookieSession(initMessage.cookieSessionRequest);
        this.sendMessage({
            type: "initCookieSession",
            payload: getCookieSession_answer
        });

    }

    protected failFatal(err: Error ) {
        try {
            this.fatalError = err;
            this.clazz.instances.resultPromises.delete(this.url); // Unregister instance, so the next client will create a new one

            // Reject this.initMessage
            try {
                this.initMessage.reject(err);
            }
            catch (e) {}

            this.methodCallPromises.forEach(p => p.reject(err)); // Reject outstanding method calls
        }
        finally {
            this.cleanUp(); // Just to make sure
        }
    }

    checkFatal() {
        if(this.fatalError) {
            throw new Error(`Connection failed: ${this.fatalError.message}, see cause`, {cause: this.fatalError})
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
            this.clazz.instances.resultPromises.delete(this.url); // Unregister instance, so the next client will create a new one

            const error = new Error("Socket connection has been closed", {cause: this.fatalError});

            // Reject this.initMessage
            try {
                this.initMessage.reject(error);
            }
            catch (e) {}

            this.methodCallPromises.forEach(p => p.reject(error)); // Reject outstanding method calls
        } finally {
            this.cleanUp(); // Just to make sure
        }
    }

    public close() {
        this.fatalError = new Error("ClientSocketConnection closed");
        this.socket.close();
    }

    /**
     * Will also close this connection if it's not used by a client anymore
     * @param client
     */
    unregisterClient(client: RestfuncsClient<any>) {
        this.usedByClients.delete(client);
        if(this.usedByClients.size == 0) {
            this.close();
        }
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

    updateSession() {
        // don't use doCall
    }

    async doCall(client: RestfuncsClient<IServerSession>, serverSessionClassId: string, methodName: string, args: any[]): Promise<unknown> {
        this.checkFatal();

        const exec_inner = async () => {
            await this.cookieSessionSyncOp.waitTilIdle();

            // Create and register a MethodCallPromise:
            const callId = ++this.callIdGenerator;
            const methodCallPromise = new MethodCallPromise();
            this.methodCallPromises.set(callId, methodCallPromise) // Register call

            //Send the call message to the server:
            this.sendMessage({
                type: "methodCall",
                payload: {
                    callId, serverSessionClassId, methodName, args
                }
            });

            return await methodCallPromise // Wait till the return message arrived and the promise is resolved
        }

        /**
         * Exec with retry/waiting on cookieSession sync
         */
        const exec = async () => {
            const callResult = await exec_inner();
            if(callResult.status === "dropped_CookieSessionIsOutdated") {
                // TODO: exec again.
            }
            return callResult;
        }

        let callResult = await exec();


        if(callResult.needsHttpSecurityProperties) {
            // Fetch the needed HttpSecurityProperties and update them on the server
            await this.fetchHttpSecurityPropertiesOp.exec(callResult.needsHttpSecurityProperties.syncKey, async () => { // synchronize the operation with other calls
                const answer = await client.controlProxy_http.getHttpSecurityProperties(callResult.needsHttpSecurityProperties!.question);
                this.sendMessage({type: "updateHttpSecurityProperties", payload: answer});
            })

            callResult = await exec(); // Try again

            if(callResult.needsHttpSecurityProperties) { // Still needing those ?
                throw new Error("Illegal state: Call still needs httpSecurityProperties after they've already been installed")
            }
        }

        if(callResult.needsCookieSession) {
            // Fetch the needed cookieSession
            await this.fetchInitialSessionOp.exec(async () => { // TODO: which synchronizer do we use ?
                const answer = await client.controlProxy_http.getCookieSession(callResult.needsCookieSession!);

                const ignoredPromise = (async () => { // Performance: We don't have to wait for the result because normally this will succeed and it's only important that the call is enqueued and send in-order before succeeding methods calls so they will enjoy the result
                    try {
                        await this.doCall(client, serverSessionClassId, "updateHttpSecurityProperties", [answer]);
                    } catch (e) {
                        this.failFatal(e as Error);
                    }
                })();

            })

            callResult = await exec(); // Try again

            if(callResult.needsCookieSession) { // Still needing those ?
                throw new Error("Illegal state: Call still needs cookieSession after it's already been installed")
            }
        }

        if(callResult.doCookieSessionUpdate) {
            // TODO: sync
            const newSession = await client.controlProxy_http.updateCookieSession(callResult.doCookieSessionUpdate, (await this.initMessage).cookieSessionRequest); // Update on the http side and get the newer session
            await this.doCall(client, serverSessionClassId, "updateCookieSession", [newSession]) // TODO: Performance: We could not wait for the result, cause this would likely succeed and further calls would be free to go immedieately
        }

        if (callResult.error) {
            throw new ServerError(callResult.error, {}, callResult.httpStatusCode);
        }
        if (callResult.status == 550) { // "throw legal value" (non-error)
            throw callResult.result
        }

        return callResult.result;

        try {
            return await exec();
        } catch (e) {
            if (typeof e === "object" && (e as any)?.httpStatusCode === 480) { // Invalid token error ?
                await client.fetchCorsReadToken()
                return await exec(); // try once again;
            } else {
                throw e;
            }
        }
    }


    private sendMessage(message: Socket_Client2ServerMessage) {
        this.socket.send(this.serializeMessage(message))
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
        this.checkFatal()

        // Switch on type:
        if(message.type === "init") {
            this.initMessage.resolve(message.payload as Socket_Server2ClientInit);
        }
        else if(message.type === "methodCallResult") {
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
        methodCallpromise.resolve(resultFromServer);
    }
}