import {Socket, SocketOptions} from "engine.io-client";
import {isNode, DropConcurrentOperationMap, DropConcurrentOperation} from "./Util";
import {RestfuncsClient, ServerError} from "./index";
import {
    _testForRaceCondition_breakPoints,
    ClientCallbackDTO, cloneError,
    CookieSessionState, fixErrorStack,
    GetCookieSessionAnswerToken,
    IServerSession, ServerPrivateBox, Socket_ChannelItemNotUsedAnymore,
    Socket_Client2ServerMessage, Socket_DownCall,
    Socket_MethodUpCallResult, Socket_Server2ClientInit,
    Socket_Server2ClientMessage
} from "restfuncs-common";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";
import _ from "underscore";
import {ExternalPromise, fixErrorForJest, visitReplace} from "restfuncs-common";
import clone from "clone";
import {TrackedSentChannelItems} from "restfuncs-common/TrackedSentChanelItems";

class MethodCallPromise extends ExternalPromise<Socket_MethodUpCallResult> {

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
    static sharedInstances = new DropConcurrentOperationMap<string, ClientSocketConnection>()

    static engineIoOptions: Partial<SocketOptions> = {
        transports: isNode?['websocket', 'webtransport']:undefined // Don't use "polling" in node. It does currently does not work in node 21.0.0
    }

    public url!: string;
    public socket!: Socket
    protected firstClient!: RestfuncsClient<any>

    /**
     * Send from the server after connection
     * @protected
     */
    protected initMessage = new ExternalPromise<Socket_Server2ClientInit>()

    lastSentMessageSequenceNumber = 0; // Or you could call it sequenceNumberGenerator
    protected callIdGenerator = 0;
    protected methodCallPromises = new Map<Number, MethodCallPromise>()

    protected trackedSentChannelItems = new TrackedSentChannelItems(this);

    /**
     * Whether the process of fetching the getHttpCookieSessionAndSecurityProperties is currently running, so we won't start it twice.
     * The key is either the security group id or ServerSession id, depending on what's the server's preference. See Socket_MethodCallResult#needsHttpSecurityProperties#syncKey
     * @protected
     */
    protected fetchHttpSecurityPropertiesOp  = new DropConcurrentOperationMap<string, void>()

    protected lastSetCookieSessionOnServer: CookieSessionState

    /**
     * If the cookieSession is currently "outdated" on the server, someone has to fix it by re-fetching it from the http side.
     * See {@link ServerSocketConnection#setCookieSession} scenarios: B, C, D
     * @protected
     */
    protected fixOutdatedCookieSessionOp = new DropConcurrentOperation<void>()

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
    static async getSharedInstance(url: string, client: RestfuncsClient<any>): Promise<ClientSocketConnection> {
        const result = await this.sharedInstances.exec(url, async () => {
            return this.New(url, client);
        });

        // Safety/security check, that the first client did not initialized the httpSecurityProperties with a weaker mode than what we want:
        if(result.firstClient.csrfProtectionMode !== client.csrfProtectionMode) {
            throw new Error(`RestfuncsClients for the same url '${url}' have different csrfProtectionModes. Yours: ${client.csrfProtectionMode}; other: ${result.firstClient.csrfProtectionMode}`)
        }

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
        this.firstClient = initClient;
        this.usedByClients.add(initClient)

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

        await this.fetchAndSetCookieSession();

        this.checkFatal(); // Fresh instance must not be failed
    }

    protected failFatal(err: Error ) {
        try {
            this.fatalError = err;
            this.clazz.sharedInstances.resultPromises.delete(this.url); // Unregister instance, so the next client will create a new one

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
            throw fixErrorForJest(new Error(`Connection failed: ${this.fatalError.message}, see cause`, {cause: this.fatalError}))
        }
    }


    private cleanUp() {
        //Dereference resources, just to make sure. We just got a signal that something was wrong but don't know, if the socket is still open -> references this's listeners -> references this / prevents GC
        this.methodCallPromises.clear();
        this.trackedSentChannelItems.items.clear();
        this.socket.removeAllListeners() // With no arg, does this really remove all listeners then ?
    }

    protected onClose() {
        try {
            this.clazz.sharedInstances.resultPromises.delete(this.url); // Unregister instance, so the next client will create a new one

            const error = fixErrorForJest(new Error("Socket connection has been closed", {cause: this.fatalError}));

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
     * Scans args and replaces those items with DTOs and registers them on this.channelItemsOnServer (assuming, args gets definitely get sent to the server afterwards)
     * @param args
     */
    private docall_exec_insertChannelItemDTOs(args: unknown[]) {
        try {
            let numerOfFunctionDTOs = 0;
            visitReplace(args, (item, visitChilds, context) => {
                if (typeof item === "function") {
                    // Check if supported by server:
                    if(this.firstClient.serverProtocolVersion!.feature < 2) {
                        throw new Error("Cannot use callbacks. Server version to old. Please upgrade the restfuncs-server to >=3.1")
                    }

                    const id = this.trackedSentChannelItems.registerItemBeforeSending(item);
                    const functionDTO: ClientCallbackDTO = {_dtoType: "ClientCallback", id};

                    numerOfFunctionDTOs++;
                    return functionDTO;
                }
                return visitChilds(item, context)
            });
        }
        catch (e) {
            this.failFatal(e as Error); // Can't clean up what we've done with this.channelItemsOnServer.set(...)
            throw e;
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

        args = clone(args); // The following line "should not delete/replace methods on the client side when serializing them". So we must clone it first. using the "clone" lib because: - it clones functions as well. It preserves the __proto__ (for, if the user sends class instances). //TODO: with future life-objects, we cannot clone the whole object tree but must stop when hitting life-objects / do both steps at once.
        this.docall_exec_insertChannelItemDTOs(args);

        const exec = async () => {
            await this.fixOutdatedCookieSessionOp.waitTilIdle(); // Wait til this one is fixed and we have a valid cookie again
            await this.pollRfSessStateCookie_once(); //

            // Create a MethodCallPromise:
            const callId = ++this.callIdGenerator;
            const methodCallPromise = new MethodCallPromise();

            //Send the call message to the server:
            this.sendMessage({
                type: "methodCall",
                payload: {
                    callId, serverSessionClassId, methodName, args
                }
            });

            this.methodCallPromises.set(callId, methodCallPromise) // Register call.
            // Minor note: no potential exception throwing code  must be here in this place between registering and awaiting. Cause when leaving it unawaited, a fatal connection error or connection close event will reject it and it crashes the whole node/jest with as "unhandled rejection"
            return await methodCallPromise // Wait till the return message arrived and the promise is resolved
        }

        let callResult: Socket_MethodUpCallResult;
        while ( (callResult = await exec()).status === "dropped_CookieSessionIsOutdated") {
            // (Somebody-) fetch the cookieSession:
            await this.fixOutdatedCookieSessionOp.exec(async () => {
                await this.fetchAndSetCookieSession();
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
    }


    protected sendMessage(message: Omit<Socket_Client2ServerMessage, "sequenceNumber">) {
        this.checkFatal()
        this.socket.send(this.serializeMessage({...message, sequenceNumber: ++this.lastSentMessageSequenceNumber}));
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
        //@ts-ignore An un-awaited async block is **needed for development** for _testForRaceCondition_breakPoints
        (async() => {
            this.checkFatal()

            // Switch on type:
            if(message.type === "init") {
                this.initMessage.resolve(message.payload as Socket_Server2ClientInit);
            }
            else if(message.type === "methodCallResult") {
                this.handleMethodCallResult(message.payload as Socket_MethodUpCallResult /* will be validated in method*/)
            }
            else if(message.type === "getVersion") {
                // Leave this for future extensibility / probing feature flags (don't throw an error)
            }
            else if(message.type === "downCall") {
                this.handleDownCall(message.payload as Socket_DownCall /* will be validated in method*/);
            }
            else if(message.type === "channelItemNotUsedAnymore") {
                await _testForRaceCondition_breakPoints.offer("client/ClientSocketConnection/handleMessage/channelItemNotUsedAnymore");
                const payload = message.payload as Socket_ChannelItemNotUsedAnymore;

                if(this.trackedSentChannelItems.items.has(payload.id) && this.trackedSentChannelItems.items.get(payload.id)!.lastTimeSent >= payload.time) { // Item was sent up again in the meanwhile and therefore is use again on the server?. Note: lastTimeSent has the message's time - 1, cause it's composed beforehead therefore the ">=" operator.
                    //  Don't delete. Prevents race condition bug (see tests for it).
                }
                else { // Normally:
                    this.trackedSentChannelItems.items.delete(payload.id); // Delete it also here
                }
            }
        })();
    }

    protected handleMethodCallResult(resultFromServer: Socket_MethodUpCallResult) {
        const methodCallpromise = this.methodCallPromises.get(resultFromServer.callId);
        if(!methodCallpromise) {
            throw new Error( `MethodCallPromise for callId: ${resultFromServer.callId} does not exist.`);
        }
        methodCallpromise.resolve(resultFromServer);
        this.methodCallPromises.delete(resultFromServer.callId);
    }

    protected handleDownCall(downCall: Socket_DownCall) {
        const fnItem = this.trackedSentChannelItems.items.get(downCall.callbackFnId)?.item;
        if(!fnItem) {
            throw new Error(`Illegal state: ClientSocketConnection does not know of this callback item (id: ${downCall.callbackFnId})`)
        }
        if(typeof fnItem !== "function") {
            throw new Error("Illegal state: fnItem is not a function");
        }

        const sendAnswer = (result: unknown, error?: unknown) => {
            if(error && error instanceof Error) {
                fixErrorStack(error);
                error = cloneError(error);
            }
            this.sendMessage({type: "methodDownCallResult", payload: {callId: downCall.id, result, error}});
        }

        // Call it and handle error/result and send it back:
        try {
            const syncResult = fnItem(...downCall.args); // Call it:

            if(syncResult && (syncResult instanceof Promise)) {
                syncResult.then(value => sendAnswer(value, undefined), error => sendAnswer(undefined, error));
            }
            else { // non-promise ?
                if (syncResult !== undefined) {
                    console.error(`A callback function returned a non-void result directly / not via promise. It will be ignored ! If you want them to arrive at the server, please return the value via Promise (/async style).`, syncResult);
                }
                if(downCall.serverAwaitsAnswer) {
                    sendAnswer(undefined, undefined);
                }
            }
        }
        catch (e) {
            if(downCall.serverAwaitsAnswer) {
                sendAnswer(undefined, undefined);
            }

            // Log the error (don't throw it, since it fails the connection)
            if(downCall.diagnosis_resultWasDeclared) {
                const message = "The callback function threw an error directly and not via promise. This error cannot be handed properly to the server."
                console.error(message, e);
                //throw fixErrorForJest(new Error(`${message} The previous console log shows, which function it was. Error message: ${e.message}`, {cause: e}));
            }
            else {
                console.error(e);
            }
        }
    }


    /**
     * Does a sync of the cookie session from the http side to the socket
     * @private
     */
    private async fetchAndSetCookieSession() {
        const answer = await this.firstClient.controlProxy_http.getCookieSession((await this.initMessage).cookieSessionRequest);
        this.setCookieSessionOnServer(answer);
    }

    public async forceSyncCookieSession() {
        await this.fixOutdatedCookieSessionOp.waitTilIdle();
        await this.fetchAndSetCookieSession();
    }

    /**
     * @returns ... All valid (=not failed) open connections. Such that are currently initializing, are awaited.
     */
    static async getAllOpenSharedConnections() {
        return (await this.sharedInstances.getAllSucceeded()).filter(v => !v.fatalError);
    }

    private static RF_SESS_STATE_COOKIE_PATTERN = /^\s*rfSessState\s*=\s*(.*)\s*$/;

    /**
     * In the rare case that something got wrong with the rfSessState cookie transmission (i.e. request failed and the rfSessState cookie will not be repeated in following requests), we still got an old value in document.cookie. this would cause an endless hammering.
     * Here we prevent this, when we know it was wrong the last time.
     */
    ensureCookieSessionUpto_wrongTargetState: CookieSessionState | "none" = "none";
    async ensureCookieSessionUpto(targetSessionState: CookieSessionState) {
        if(_.isEqual(this.ensureCookieSessionUpto_wrongTargetState, targetSessionState)) {
            return; // Prevent hammering
        }
        await this.fixOutdatedCookieSessionOp.waitTilIdle();

        const needsUpdate = () => {
            if (this.lastSetCookieSessionOnServer === undefined && targetSessionState === undefined) { // No cookie set -> no cookie ?
                return false;
            } else if (this.lastSetCookieSessionOnServer === undefined) { // No cookie -> cookie
                return true;
            }
            else if(targetSessionState === undefined) { // cookie -> no cookie
                return true;
            }
            else { // Bot are set ?
                return this.lastSetCookieSessionOnServer.id !== targetSessionState.id || this.lastSetCookieSessionOnServer.version < targetSessionState.version
            }
        }

        if(needsUpdate()) {
            await this.fixOutdatedCookieSessionOp.exec(async () => {
                await this.fetchAndSetCookieSession();

                // Safety: Help prevent hammering:
                if(needsUpdate()) { //targetSessionState was wrong and would cause an update again ?
                    this.ensureCookieSessionUpto_wrongTargetState = targetSessionState
                }
                else {
                    this.ensureCookieSessionUpto_wrongTargetState = "none"
                }
            });
        }
    }

    /**
     * Looks at the document.cookie -> "rfSessState" to recognize changes that were made by other browser windows or manual fetch requests and calls fetchAndSetCookieSession() (to do a resync) then.
     * @private
     */
    private async pollRfSessStateCookie_once() {
        if(isNode || typeof window === "undefined") { // not in a browser ?
            return;
        }
        function getRfSessStateCookie() {
            for (const cookieToken of window.document.cookie.split(";")) {
                let match = cookieToken.match(ClientSocketConnection.RF_SESS_STATE_COOKIE_PATTERN);
                if (match) {
                    const value = match[1];
                    return JSON.parse(value) as CookieSessionState;
                }
            }
            return undefined
        }

        await this.ensureCookieSessionUpto(getRfSessStateCookie());
    }
}