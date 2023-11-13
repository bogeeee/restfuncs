import {Socket, SocketOptions} from "engine.io-client";
import {isNode, ExternalPromise, SingleRetryableOperationMap, SingleRetryableOperation} from "./Util";
import {RestfuncsClient, ServerError} from "./index";
import {
    CookieSessionState,
    GetCookieSessionAnswerToken,
    IServerSession, ServerPrivateBox,
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

    /**
     * Whether the process of fetching the getHttpCookieSessionAndSecurityProperties is currently running, so we won't start it twice.
     * The key is either the security group id or ServerSession id, depending on what's the server's preference. See Socket_MethodCallResult#needsHttpSecurityProperties#syncKey
     * @protected
     */
    protected fetchHttpSecurityPropertiesOp  = new SingleRetryableOperationMap<string, void>()

    protected lastSetCookieSessionOnServer: CookieSessionState

    /**
     * If the cookieSession is currently "outdated" on the server, someone has to fix it by re-fetching it from the http side.
     * See {@link ServerSocketConnection#setCookieSession} scenarios: B, C, D
     * @protected
     */
    protected fixOutdatedCookieSessionOp = new SingleRetryableOperation<void>()

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
                        this.failFatal(typeof data === "string" && data.startsWith("[Error]") ? new Error(`ServerSocketConnection sent an error: ${data}`) : e)
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
        this.setCookieSessionOnServer(getCookieSession_answer);
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

    /**
     * Calls {@link ServerSocketConnection#setCookieSession} on the server
     * Immediately returns without waiting for an ack.
     */
    setCookieSessionOnServer(getCookieSessionResult: ReturnType<IServerSession["getCookieSession"]>) {
        this.sendMessage({type: "setCookieSession", payload: getCookieSessionResult.token})
        this.lastSetCookieSessionOnServer = getCookieSessionResult.state;
    }

    async doCall(client: RestfuncsClient<IServerSession>, serverSessionClassId: string, methodName: string, args: any[]): Promise<unknown> {
        this.checkFatal();

        const exec = async () => {
            await this.fixOutdatedCookieSessionOp.waitTilIdle(); // Wait til we have a valid cookie

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

        let callResult: Socket_MethodCallResult;
        while ( (callResult = await exec()).status === "dropped_CookieSessionIsOutdated") {
            // (Somebody-) fetch the cookieSession:
            await this.fixOutdatedCookieSessionOp.exec(async () => {
                const answer = await client.controlProxy_http.getCookieSession((await this.initMessage).cookieSessionRequest);
                this.setCookieSessionOnServer(answer);
            })
        }

        if(callResult.needsHttpSecurityProperties) {
            // (Somebody-) fetch the needed HttpSecurityProperties and update them on the server
            await this.fetchHttpSecurityPropertiesOp.exec(callResult.needsHttpSecurityProperties.syncKey, async () => {
                const answer = await client.controlProxy_http.getHttpSecurityProperties(callResult.needsHttpSecurityProperties!.question);
                this.sendMessage({type: "updateHttpSecurityProperties", payload: answer});
            })

            callResult = await exec(); // Try again

            // Safety check:
            if(callResult.needsHttpSecurityProperties) { // Still needing those ?
                throw new Error("Illegal state: Call still needs httpSecurityProperties after they've already been installed")
            }
        }

        if(callResult.needsInitializedCookieSession) { // ServerSocketConnection#setCookieSession scenario D
            // Fetch the needed cookieSession. Let others sync to us with fixOutdatedCookieSessionOp:
            this.fixOutdatedCookieSessionOp.expectIdle(); // Safety check. We should be the first
            await this.fixOutdatedCookieSessionOp.exec(async () => {
                const answer = await client.controlProxy_http.getCookieSession(callResult.needsInitializedCookieSession!);
                this.setCookieSessionOnServer(answer);
            })

            callResult = await exec(); // Try again

            // Safety check:
            if(callResult.needsInitializedCookieSession) { // Still needing those ?
                throw new Error("Illegal state: Call still needs cookieSession after it's already been installed")
            }
        }

        if(callResult.doCookieSessionUpdate) { // ServerSocketConnection#setCookieSession scenario C
            this.fixOutdatedCookieSessionOp.expectIdle(); // Safety check. We should be the only one
            await this.fixOutdatedCookieSessionOp.exec(async () => {
                const answerWithNewSession = await client.controlProxy_http.updateCookieSession(callResult.doCookieSessionUpdate!, (await this.initMessage).cookieSessionRequest); // Update on the http side and get the newer session
                this.setCookieSessionOnServer(answerWithNewSession);
            })
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


    protected sendMessage(message: Socket_Client2ServerMessage) {
        this.checkFatal()
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
        this.methodCallPromises.delete(resultFromServer.callId);
    }
}