import {
    ClientCallback,
    ClientCallbackProperties,
    ServerSession,
    RemoteMethodCallbackMeta,
    SwappableArgs, SwapPlaceholders_args, UnknownFunction, diag_sourceLocation
} from "./ServerSession";
import {RestfuncsServer, SecurityGroup} from "./Server";
import {Socket} from "engine.io";
import {
    CookieSession,
    CookieSessionUpdate, GetCookieSessionAnswerToken,
    GetCookieSession_question,
    GetHttpSecurityProperties_answer,
    GetHttpSecurityProperties_question,
    SecurityPropertiesOfHttpRequest, ServerPrivateBox,
    Socket_Client2ServerMessage,
    Socket_MethodCall,
    Socket_MethodUpCallResult,
    Socket_Server2ClientInit,
    Socket_Server2ClientMessage,
    UploadFile,
    visitReplace,
    ChannelItemDTO,
    ClientCallbackDTO,
    Socket_DownCall,
    Socket_DownCallResult, fixErrorForJest
} from "restfuncs-common";
import _ from "underscore";
import {Readable} from "node:stream";
import {CommunicationError, isCommunicationError} from "./CommunicationError";
import {diagnisis_shortenValue, fixErrorStack} from "./Util";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";
import crypto from "node:crypto";
import nacl_util from "tweetnacl-util";
import {ExternalPromise} from "restfuncs-common";
import {WeakValueMap} from "restfuncs-common";

const FEATURE_ENABLE_CALLBACKS = true;

export class ServerSocketConnection {
    _id = crypto.randomBytes(16); // Length should resist brute-force over the network against a small pool of held connection-ids
    server: RestfuncsServer
    socket: Socket
    public closeReason?:CloseReason;

    lastSequenceNumberFromClient=-1;

    /**
     * The raw cookie-session values that were obtained from a http call.
     * Lazy / can be undefined, if no session-cookie was yet set. I.e the user did not yet login
     * "syncing" = we know that we don't have a valid info here. Rejects further ServerSession method calls then.
     */
    cookieSession?: CookieSession | "outdated" = "outdated"

    //cache_allowedSecurityGroupIds = new Set<string>(); // TODO: implement faster approving. Invalidate, when the cookie session changes (cookieSession's csrfProtectionMode, tokens vs. SecurityPropertiesOfHttpRequest) )

    /**
     *
     */
    securityGroup2SecurityPropertiesOfHttpRequest?: Map<SecurityGroup, Readonly<SecurityPropertiesOfHttpRequest>>

    serverSessionClass2SecurityPropertiesOfHttpRequest?: Map<typeof ServerSession, Readonly<SecurityPropertiesOfHttpRequest>>

    /**
     * For worry-free feature: Remember the same function instances. This could be useful if you register/unregister a subscription. I.e. like in the browser's addEventListener / removeEventListener functions.
     * id -> callback function
     */
    clientCallbacks = new WeakValueMap<number, ClientCallback>([], (id) => {
        this.sendMessage({type: "channelItemNotUsedAnymore", payload: {id, time: this.lastSequenceNumberFromClient}}); // Inform the client that the callback is not referenced anymore
    });

    protected downcallIdGenerator = 0;

    /**
     * Downcalls of client-initialted callbacks
     * On such that return via promise
     * @protected
     */
    protected methodDownCallPromises = new Map<number, ExternalPromise<Socket_DownCallResult>>()

    /**
     * Track if client GCed or closed the stream or pulls from them.
     * @protected
     */
    protected sentReadables = new Map<number, Readable>()

    // TODO Finalization registry for client initiated Readbles to signal GC to the client
    // TODO Finalization registry for client initiated UploadFiles to signal GC to the client

    /**
     * TODO: Imagine the case of a forgotten ClientCallbacksForEntities instance. Use an IterableWeakSet
     * @protected
     */
    protected weakOnCloseListeners = new Set<OnCloseHandlerInterface>();

    protected onCloseListeners = new Set<(reason?: CloseReason) => void>();


    /**
     * TODO: Let the client set this in a hello message (there is no such thing currently)
     */
    public trimArguments_clientPreference = true;

    /**
     * Whether to use the security group or the ServerSession class to associate security state
     */
    get useSecurityGroups() {
        // State check:
        if(this.securityGroup2SecurityPropertiesOfHttpRequest && this.serverSessionClass2SecurityPropertiesOfHttpRequest) { // Both are initialized ?
            throw new Error("Illegal state")
        }
        if(!this.securityGroup2SecurityPropertiesOfHttpRequest && !this.serverSessionClass2SecurityPropertiesOfHttpRequest) { // None are initialized ?
            throw new Error("Illegal state")
        }

        return this.securityGroup2SecurityPropertiesOfHttpRequest !== undefined;
    }

    get id() {
        return nacl_util.encodeBase64(this._id); // TODO: use from socket
    }

    constructor(server: RestfuncsServer, socket: Socket) {
        this.server = server;
        this.socket = socket;

        if(this.server.serverOptions.socket_requireAccessProofForIndividualServerSession !== false) { // default
            this.serverSessionClass2SecurityPropertiesOfHttpRequest = new Map();
        }
        else {
            this.securityGroup2SecurityPropertiesOfHttpRequest = new Map();
        }

        socket.on("message", (data: string | Buffer) => {
            const message = this.deserializeMessage(data);
            try {
                this.handleMessage(message as Socket_Client2ServerMessage /* will be validated in method*/);
            }
            catch (e: any) {
                this.socket.send("[Error] " + (e?.message || e));
            }
        })

        socket.on("close", (message: string, obj?: object) => {
            this.handleClose((message || obj)?{message, obj}:undefined);
        });

        socket.on("error", (error: Error) => {
            // Make sure it is closed:
            try {
                socket.close()
            }
            catch (e) {
            }
            this.closeReason = error;
            this.handleClose(error);
        });

        // TODO: Performance: Could we just use the http cookie here ? At least for our own JWT cookie handler. There we also know how to do a validity check.

        const initMessage: Socket_Server2ClientInit = {
            cookieSessionRequest: this.server.server2serverEncryptToken({
                serverSocketConnectionId: this.id, forceInitialize: false
            }, "GetCookieSession_question")
        }
        this.sendMessage({type: "init", payload: initMessage})
    }

    protected deserializeMessage(data: string | Buffer): unknown {
        if (typeof data !== "string") {
            throw new Error("Data must be of type string");
        }
        return brilloutJsonParse(data);
    }

    protected serializeMessage(message: Socket_Server2ClientMessage): unknown {
        return brilloutJsonStringify(message)
    }

    protected sendMessage(message: Socket_Server2ClientMessage) {
        this.socket.send(this.serializeMessage(message));
    }

    public failFatal(error: Error) {
        this.socket.send("[Error] " + error.message);
        this.close(error);
    }

    /**
     *
     * @param message The raw, evil value from the client.
     * @protected
     */
    protected handleMessage(message: Socket_Client2ServerMessage) {
        // Validate input: (TODO: write a testcase for evil input values)
        if(!message) {
            throw new Error("message is null/undefined");
        }
        if(typeof message !== "object") {
            throw new Error("message is not an object");
        }
        if(typeof message.type !== "string") {
            throw new Error("message.type is not a string");
        }
        // Validate and fix sequenceNumber for older clients:
        if(typeof message.sequenceNumber !== "number") {
            message.sequenceNumber = 0;
        }

        this.lastSequenceNumberFromClient = message.sequenceNumber;

        // Switch on type:
        if(message.type === "methodCall") {
            this.handleMethodCall(message.payload as Socket_MethodCall /* will be validated in method*/)
        }
        else if(message.type === "methodDownCallResult") {
            this.handleMethodDownCallResultMessage(message.payload as Socket_DownCallResult /* will be validated in method*/)
        }
        else if(message.type === "getVersion") {
            // Leave this for future extensibility / probing feature flags (don't throw an error)
        }
        else if(message.type === "updateHttpSecurityProperties") {
            this.updateHttpSecurityProperties(message.payload);
        }
        else if(message.type === "setCookieSession") {
            this.setCookieSession(message.payload);
        }
        else {
            throw new Error(`Unhandled message type: ${message.type}`)
        }

    }

    /**
     * <p>
     *     The structure of this method is explained in 'ServerSocketConnection breakdown.md'
     * </p>
     * @param methodCall the raw, evil value from the client.
     * @protected
     */
    protected handleMethodCall(methodCall: Socket_MethodCall) {
        // Validate the type (damn, how does it feel without restfuncs if you had to write this for **every** of your API endpoints ;) ):
        // (TODO: write a testcase for evil input values)
        if(!methodCall || (typeof methodCall !== "object")) {
            throw new Error("methodCall is not an object");
        }
        if(typeof methodCall.callId !== "number") {
            throw new Error("callId is not a number");
        }


        /**
         * This function definitely returns a (one) Socket_MethodCallResult. This is the safer arrangement than calling this.sendMessage from multiple places
         */
        const handleMethodCall_inner = async (): Promise<Omit<Socket_MethodUpCallResult, "callId">> => {
            try { // We can properly answer errors from here on

                // Continue validating:
                if (typeof methodCall.methodName !== "string") {
                    throw new Error("methodCall.methodName is not a string");
                }
                if (methodCall.serverSessionClassId !== undefined && typeof methodCall.serverSessionClassId !== "string") {
                    throw new Error("Invalid value for methodCall.serverSessionClassId");
                }
                if (!_.isArray(methodCall.args)) {
                    throw new Error("methodCall.args is not an array");
                }
                if (!methodCall.serverSessionClassId) {
                    throw new Error("methodCall.serverSessionClassId not set");
                }
                // Validate cookieSession:
                if(this.cookieSession === "outdated") {
                    return {
                        status: "dropped_CookieSessionIsOutdated"
                    }
                }
                if(this.cookieSession && !(await this.server.cookieSessionIsValid(this.cookieSession))) { // Not valid ? Either a timeout or a newer version already exists
                    this.cookieSession = "outdated"
                    return {
                        status: "dropped_CookieSessionIsOutdated",
                    }
                }

                // Obtain serverSessionClass:
                const serverSessionClass = this.server.serverSessionClasses.get(methodCall.serverSessionClassId);
                if (!serverSessionClass) {
                    throw new Error(`A ServerSessionClass with the id: '${methodCall.serverSessionClassId}' is not registered.`);
                }

                // Determine security properties (request fetch if necessary):
                let securityPropertiesOfHttpRequest
                if (this.useSecurityGroups) {
                    securityPropertiesOfHttpRequest = this.securityGroup2SecurityPropertiesOfHttpRequest!.get(serverSessionClass.securityGroup);
                } else { // default
                    securityPropertiesOfHttpRequest = this.serverSessionClass2SecurityPropertiesOfHttpRequest!.get(serverSessionClass);
                }
                if (!securityPropertiesOfHttpRequest) {
                    // Block call and request the client to send those securityProperties first:
                    return {
                        needsHttpSecurityProperties: {
                            question: this.server.server2serverEncryptToken({
                                serverSocketConnectionId: this.id,
                                serverSessionClassId: serverSessionClass.id,
                            }, "GetHttpSecurityProperties_question"),
                            syncKey: this.useSecurityGroups ? serverSessionClass.securityGroup.id : serverSessionClass.id,
                        },
                        status: "needsHttpSecurityProperties"
                    }
                }
                const securityPropsForThisCall: SecurityPropertiesOfHttpRequest = {
                    ...securityPropertiesOfHttpRequest,
                    readWasProven: true  // Flag that we are sure that our client made a successful read (he successfully passed us the GetHttpSecurityProperties_answer)
                };

                // Exec the call (serverSessionClass.doCall_outer) and return result/error:
                try {
                    let swappableArgs: SwappableArgs = {argsWithPlaceholders: methodCall.args}
                    if(FEATURE_ENABLE_CALLBACKS) {
                        swappableArgs = this.handleMethodCall_resolveChannelItemDTOs(methodCall.args); // resolve / register them
                    }
                    const { result, modifiedSession} = await serverSessionClass.doCall_outer(this.cookieSession, securityPropsForThisCall, methodCall.methodName, swappableArgs, {socketConnection: this, securityProps: securityPropsForThisCall}, this.trimArguments_clientPreference,{})

                    // Check if result is of illegal type:
                    const disallowedReturnTypes = {
                        "Readable": Readable,
                        "ReadableStream": ReadableStream,
                        "ReadableStreamDefaultReader": ReadableStreamDefaultReader,
                        "Buffer": Buffer
                    };
                    for (const [name, type] of Object.entries(disallowedReturnTypes)) {
                        if (result instanceof type) {
                            throw new CommunicationError(`${methodCall.methodName}'s result of type ${name} is not supported when calling via socket`)
                        }
                    }

                    if (modifiedSession) {
                        if(!this.cookieSession) { // New session ?
                            // Or is it better to just just create one ourself and send it to the main http site then ?
                            // - Pro: Safes us 2 a round trips
                            // - Pro: Avoids the unexpected behaviours that the call is re-executed
                            // - Neutral: You could create 2 independent cookieSessions (socket, http) on which you can work with at the same time. But is that a security problem ?
                            // - Con: An attacker could use then use this fresh session as his stock session and install it to victim(s) on the http side. Assuming he has at least access to one publicly allowed service (allowed origin) but that means nothing.
                            // - Con: When the session is tried to be installed on the http side and before that happens, the access check initializes it (i.e. for corsReadToken), there will be some trouble.
                            // - Con: Does not work with a non-restfuncs session handler that wants to do its own initialization (set its own id) / validation, etc.

                            // Before proceeding, we must request and install an initial cookie session. See setCookieSession - scenario D. The client must do the call again then.
                            this.cookieSession = "outdated"
                            return {
                                needsInitializedCookieSession: this.server.server2serverEncryptToken({
                                    serverSocketConnectionId: this.id,
                                    forceInitialize: true
                                }, "GetCookieSession_question"),
                                status: "needsCookieSession"
                            }
                        }

                        // Safety check:
                        if(!modifiedSession.id || modifiedSession.version === undefined) {
                            throw new Error("Illegal state: id and version should be set, cause this.cookieSession was already initialized before the call")
                        }


                        // Wait until it's committed to the http side. Don't commit session to the validator yet, because the connection to the client can break.
                        this.cookieSession = "outdated"
                        return {
                            result,
                            doCookieSessionUpdate: this.server.server2serverEncryptToken({
                                serverSessionClassId: serverSessionClass.id,
                                newSession: modifiedSession as CookieSession /* cast cause we're sure now that there is an id */
                            }, "CookieSessionUpdate"),
                            status: "doCookieSessionUpdate"
                        }

                    }

                    return {
                        result,
                        status: 200
                    }
                } catch (caught) {
                    if (caught instanceof Error) {
                        const httpStatusCode = (isCommunicationError(caught) && (<CommunicationError>caught).httpStatusCode || 500);

                        fixErrorStack(caught)
                        let error = serverSessionClass.logAndConcealError(caught, {socketConnection: this});

                        return{
                            error: error,
                            status: 500,
                            httpStatusCode
                        };
                    } else { // Something other than an error was thrown ? I.e. you can use try-catch with "things" as as legal control flow through server->client
                        // Just send it:
                        return{
                            result: caught,
                            status: 550 // Indicate "throw legal value" to the client
                        };
                    }
                }
            } catch (e: any) { // Catch common error (before we could execute the call)
                return {
                    error: {
                        message: e?.message || e,
                        name: e?.name,
                    },
                    status: 500
                };
            }
        }

        // Send the the result from handleMethodCall_inner:
        (async () => {
            const payload: Socket_MethodUpCallResult = {
                callId: methodCall.callId,
                ... await handleMethodCall_inner()
            }
            this.sendMessage({type: "methodCallResult", payload});
        })();
    }

    /**
     * Replaces all ClientCallback objects in the arguments with functions that do the down call
     *
     */
    handleMethodCall_resolveChannelItemDTOs(remoteMethodArgs: unknown[]): SwappableArgs {
        const swapperFns: ((args: SwapPlaceholders_args) => void)[] = [];

        visitReplace(remoteMethodArgs, (item, visitChilds, context) => {
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

                const swapValueTo = (newValue: unknown) => {
                    //@ts-ignore
                    context.parentObject[context.key] = newValue;
                }

                if(dtoItem._dtoType === "ClientCallback") { // ClientCallback DTO ?
                    swapperFns.push((swapperArgs: SwapPlaceholders_args) => {
                        // Determine / create callback:
                        const existing = this.clientCallbacks.peek(id);  // use .peek instead of .get to not trigger a reporting of a lost item to the client. Cause we already have the new one for that id and this would impose a race condition/error.
                        let callback: ClientCallback;
                        if(existing) { // Already exists ?
                            callback = existing;
                        }
                        else {
                            // Create a new callback (function + properties):
                            const callbackProperties: ClientCallbackProperties = {
                                socketConnection: this,
                                id: id,
                                free: () => {
                                    this.freeClientCallback(callback!)
                                },
                                _handedUpViaRemoteMethods: new Map(),
                                _validateAndCall: (args: unknown[], trimArguments: boolean, trimResult: boolean, useSignatureForTrim: UnknownFunction | undefined, diagnosis): Promise<unknown> | undefined => {
                                    // <- **** here, the callback gets called (yeah) ****

                                    // Validity check:
                                    if (this.clientCallbacks.get(callback.id) === undefined) {
                                        throw new Error(`Cannot call callback after you have already freed it (see: import {free} from "restfuncs-server").`)
                                    }

                                    // It' better, to record these at the point of time **before** the call (at least before the await...the downcall line)
                                    const handedUpViaRemoteMethods = [...callback._handedUpViaRemoteMethods.values()]
                                    const metas = handedUpViaRemoteMethods.filter(entry => !entry.serverSessionClass.isSecurityDisabled).map(entry => entry.serverSessionClass.getRemoteMethodMeta(entry.remoteMethodName).callbacks[entry.callbackIndex]);
                                    const hasADeclaredResult = metas.some(entry => entry.awaitedResult !== undefined);
                                    const usedInSecDisabledServerSession = callback._handedUpViaRemoteMethods.size === 0 ||  [...callback._handedUpViaRemoteMethods.values()].some(entry => entry.serverSessionClass.isSecurityDisabled);

                                    // Validate arguments:
                                    {
                                        // Collect validationSpots: The places where the callback was declared, that definitely need validation:
                                        const validationSpots: ValidationSpot[] = [];
                                        for (const usage of handedUpViaRemoteMethods) {
                                            if (usage.serverSessionClass.isSecurityDisabled) {
                                                continue
                                            }
                                            if (usage.serverSessionClass._public_getRemoteMethodOptions(usage.remoteMethodName).validateCallbackArguments === false) {
                                                continue;
                                            }
                                            const meta = usage.serverSessionClass.getRemoteMethodMeta(usage.remoteMethodName).callbacks[usage.callbackIndex];

                                            // obtain trim (for this meta):
                                            let trim = trimArguments;
                                            if (trimArguments && useSignatureForTrim !== undefined) {
                                                const entry = callback._handedUpViaRemoteMethods.get(useSignatureForTrim);
                                                trim = (entry !== undefined && !entry.serverSessionClass.isSecurityDisabled && entry.serverSessionClass.getRemoteMethodMeta(entry.remoteMethodName).callbacks[entry.callbackIndex] === meta) // signature is for this meta ?
                                            }

                                            validationSpots.push({meta, trim})
                                        }

                                        // Do the validation:
                                        validationSpots.forEach(vs => this.validateDowncallArguments(args, vs, { allValidationSpots: validationSpots, plusOthers: handedUpViaRemoteMethods.length - validationSpots.length }));
                                    }


                                    // *** Execute the downcall ***:
                                    const mustWaitForAnAnswer = hasADeclaredResult || usedInSecDisabledServerSession;  // May it return a result ?
                                    const downCall: Socket_DownCall = {
                                        id: ++this.downcallIdGenerator,
                                        callbackFnId: callback.id,
                                        args: args,
                                        serverAwaitsAnswer: mustWaitForAnAnswer,
                                        diagnosis_resultWasDeclared: hasADeclaredResult
                                    }
                                    this.sendMessage({type: "downCall", payload: downCall})

                                    if(mustWaitForAnAnswer) {
                                        // Check the resource limit:
                                        if(!usedInSecDisabledServerSession && this.server.serverOptions.resourceLimits?.maxDownCallsPerSocket && this.server.serverOptions.resourceLimits.maxDownCallsPerSocket >= this.methodDownCallPromises.size) {
                                            throw new Error(`Resource limit of ServerOptions#resourceLimits.maxDownCallsPerSocket=${this.server.serverOptions.resourceLimits?.maxDownCallsPerSocket} reached. Please make sure, that your callback functions return in time.`);
                                        }

                                        return (async () => {  // Note: here we go into async mode as late as possible
                                            // Await the downcall:
                                            const downCallPromise = new ExternalPromise<Socket_DownCallResult>();
                                            this.methodDownCallPromises.set(downCall.id, downCallPromise)
                                            const downCallResult = await downCallPromise;

                                            // Handle, if client throw an error:
                                            if (downCallResult.error) {
                                                throw new Error(`The client threw an error: ${diagnisis_shortenValue(downCallResult.error)}\nTODO: format error. Thereby treat error as evil`);
                                            }

                                            // Collect validationSpots: The places where the callback was declared, that definitely need validation:
                                            const validationSpots: ValidationSpot[] = [];
                                            for (const usage of handedUpViaRemoteMethods) {
                                                if (usage.serverSessionClass.isSecurityDisabled) {
                                                    continue
                                                }
                                                if (usage.serverSessionClass._public_getRemoteMethodOptions(usage.remoteMethodName).validateCallbackResult === false) {
                                                    continue;
                                                }
                                                const meta = usage.serverSessionClass.getRemoteMethodMeta(usage.remoteMethodName).callbacks[usage.callbackIndex];
                                                if (usedInSecDisabledServerSession && meta.awaitedResult === undefined) {
                                                    continue;  // There could be void callbacks. That's ok. Filter them out
                                                }

                                                // obtain trim (for this meta):
                                                let trim = trimResult;
                                                if (trimResult && useSignatureForTrim !== undefined) {
                                                    const entry = callback._handedUpViaRemoteMethods.get(useSignatureForTrim);
                                                    trim = (entry !== undefined && !entry.serverSessionClass.isSecurityDisabled && entry.serverSessionClass.getRemoteMethodMeta(entry.remoteMethodName).callbacks[entry.callbackIndex] === meta) // signature is for this meta ?
                                                }

                                                validationSpots.push({meta, trim})
                                            }

                                            // Do the validation:
                                            validationSpots.forEach(vs => this.validateDowncallResult(downCallResult.result, vs, {
                                                allValidationSpots: validationSpots,
                                                plusOthers: handedUpViaRemoteMethods.length - validationSpots.length
                                            }));

                                            return downCallResult.result;
                                        })();
                                    }
                                    else { // Callback is definitely void ?
                                        if(diagnosis?.isFromClientCallbacks_CallForSure) {
                                            // In theory, we could allow this and pretend, that is it's a Promise<void>. But too much extra effort, just for this case.
                                            throw new Error(`callForSure(...) found a callback, that's declared as returning 'void'. You must declare it as returning 'Promise<void>' instead. Location(s):\n${metas.map(meta => diag_sourceLocation(meta.diagnosis_source, true)).join("\n")}`);
                                        }
                                        return;
                                    }
                                },

                            }
                            callback = _.extend((...args: unknown[]) => {
                                return callback._validateAndCall(args, false, false);
                            }, callbackProperties);
                        }

                        // Register that the callback was handed up here (for security validations):
                        //@ts-ignore
                        const remoteMethodInstance = swapperArgs.serverSessionClass.prototype[swapperArgs.remoteMethodName];
                        if(!remoteMethodInstance || !(typeof remoteMethodInstance === "function")) {
                            throw new Error("not a function");
                        }
                        if(!callback._handedUpViaRemoteMethods.has(remoteMethodInstance)) { // not yet registered
                            const callbackIndex = 0; // I cannot imagine a safe way to determine this. So we must limit it to one allowed function declaration per remote method. See the following check:

                            // Safety check: Remote method has more than one callback declared ? (not supported)
                            if(!swapperArgs.serverSessionClass.isSecurityDisabled) {
                                const possibleCallbackDeclarations = swapperArgs.serverSessionClass.getRemoteMethodMeta(swapperArgs.remoteMethodName).callbacks;
                                if(possibleCallbackDeclarations.length > 1) {
                                    throw new Error(`More than one callback declarations inside the line of a remote method are currently not supported (Hint: see RemoteMethodOptions#allowCallbacksAnywhere). The callbacks are declared at the following locations:\n${possibleCallbackDeclarations.map(decl => diag_sourceLocation(decl.diagnosis_source, true)).join("\n")}`);
                                }
                            }

                            // Safety check (mixed variants), to prevent against an attacker upgrading to non-void and provoke an unhandledrejection somewhere. Or against accidential unhandledrejections in user's code:
                            if(!swapperArgs.serverSessionClass.isSecurityDisabled) {
                                const existingCallbackMetas = [...callback._handedUpViaRemoteMethods.values()].filter(entry => !entry.serverSessionClass.isSecurityDisabled).map(entry => entry.serverSessionClass.getRemoteMethodMeta(entry.remoteMethodName).callbacks[entry.callbackIndex]);
                                const newMeta = swapperArgs.serverSessionClass.getRemoteMethodMeta(swapperArgs.remoteMethodName).callbacks[callbackIndex];
                                if(existingCallbackMetas.length > 0 && (existingCallbackMetas[0].awaitedResult === undefined) !== (newMeta.awaitedResult === undefined) ) {
                                    throw new Error("A callback, that you're handing up, was declared in mixed variants: Returning void + returning a Promise. We don't allow this, to save you from possible unhandledrejections in your application code (not awaiting + error-handling in one of the places). The callback was declared at the following places:\n" + [newMeta, ...existingCallbackMetas].map(m => diag_sourceLocation(m.diagnosis_source, true)).join("\n"));
                                }
                            }

                            // Register:
                            callback._handedUpViaRemoteMethods.set(remoteMethodInstance, {
                                serverSessionClass: swapperArgs.serverSessionClass,
                                remoteMethodName: swapperArgs.remoteMethodName,
                                callbackIndex,
                            })
                        }

                        this.clientCallbacks.set(id, callback!); // Register it on client's id, so that the function instance can be reused:
                        swapValueTo(callback);
                    });
                    return "_callback"; // replace with placeholder for now.
                }
                else {
                    throw new Error(`Unhandled dto type:${dtoItem._dtoType}`)
                }

            }
            else {
                return visitChilds(item, context)
            }
        });

        return {
            argsWithPlaceholders: remoteMethodArgs,
            swapCallbackPlaceholders: swapperFns.length > 0? (args) => {swapperFns.forEach(f => f(args))} :undefined // calls all swapperFns.
        }
    }

    protected handleMethodDownCallResultMessage(resultFromClient: Socket_DownCallResult) {
        // Validate the evil input:
        // (TODO: write a testcase for evil input values)
        if(!resultFromClient || (typeof resultFromClient !== "object")) {
            throw new Error("resultFromClient is not an object");
        }
        if(typeof resultFromClient.callId !== "number") {
            throw new Error("callId is not a number");
        }

        const methodDownCallpromise = this.methodDownCallPromises.get(resultFromClient.callId);
        if(!methodDownCallpromise) {
            throw new Error( `MethodDownCallPromise for callId: ${resultFromClient.callId} does not exist.`);
        }
        this.methodDownCallPromises.delete(resultFromClient.callId);
        methodDownCallpromise.resolve(resultFromClient);
    }

    /**
     *
     */
    protected validateDowncallResult(result: unknown, validationSpot: ValidationSpot, diagnosis: {allValidationSpots: ValidationSpot[], plusOthers: number}) {
        const {meta, trim} = validationSpot;
        if(meta.awaitedResult === undefined) {
            throw new Error("Illegal state: awaitedResult not defined")
        }

        // Validate:
        const validationResult = trim?meta.awaitedResult.validatePrune(result):meta.awaitedResult.validateEquals(result);
        if(validationResult.success) {
            return;
        }

        // *** Compose error message and throw it ***:

        // Compose errors into readable messages:
        const readableErrors: string[] = validationResult.errors.map(error => {
            const improvedPath = error.path.replace(/^\$input/,"<result>")
            return `${improvedPath !== "<result>"?`${improvedPath}: `: ""}expected ${error.expected} but got: ${diagnisis_shortenValue(error.value)}`
        })

        // *** Obtain diagnosis_declaredSuffix ***:
        let diagnosis_declaredSuffix: string;
        // Obtain diagnosis_hasDifferentSignatures:
        let diagnosis_hasDifferentSignatures = false;
        {
            let sourceSignature: string | undefined;
            for(const vs of diagnosis.allValidationSpots) {
                const sig = vs.meta.diagnosis_source.signatureText; // TODO: use vs.meta.result.diagnosis_source instead
                if(sourceSignature !== undefined && sourceSignature != sig) {
                    diagnosis_hasDifferentSignatures = true;
                    break;
                }
                sourceSignature = sig
            }
        }
        if(diagnosis_hasDifferentSignatures) {
            diagnosis_declaredSuffix = `The callback was handed up in multiple locations, which declared it with different return types. Therefore, all have to be validated. Locations:\n`;
            // TODO: use vs.meta.result.diagnosis_source instead
            diagnosis_declaredSuffix+= diagnosis.allValidationSpots.map(vs => `${diag_sourceLocation(vs.meta.diagnosis_source, true)}${vs.trim?" <-- extra properties get trimmed off":""}${vs === validationSpot?" <-- this one failed validation!":""}`).join("\n");
            if(diagnosis.plusOthers) {
                diagnosis_declaredSuffix+=`\n...plus ${diagnosis.plusOthers} other place(s), which don't require validation`;
            }
        }
        else {
            diagnosis_declaredSuffix = `The callback's return type was declared in ${diag_sourceLocation(meta.diagnosis_source, true)}`; // TODO: use vs.meta.result.diagnosis_source instead
        }

        const separateLines = readableErrors.length > 1;
        throw new Error(`The client returned an invalid value:${separateLines ? "\n" : " "}${readableErrors.join("\n")}\n${diagnosis_declaredSuffix}`);
    }


    /**
     *
     */
    protected validateDowncallArguments(args: unknown[], validationSpot: ValidationSpot, diagnosis: {allValidationSpots: ValidationSpot[], plusOthers: number}) {
        const {meta, trim} = validationSpot;

        // Validate:
        const validationResult = trim?meta.arguments.validatePrune(args):meta.arguments.validateEquals(args);
        if(validationResult.success) {
            return;
        }

        // *** Compose error message and throw it ***:

        // *** Obtain diagnosis_declaredSuffix ***:
        let diagnosis_declaredSuffix: string;
        // Obtain diagnosis_hasDifferentSignatures:
        let diagnosis_hasDifferentSignatures = false;
        {
            let sourceSignature: string | undefined;
            for(const vs of diagnosis.allValidationSpots) {
                const sig = vs.meta.diagnosis_source.signatureText; // TODO: use vs.meta.arguments.diagnosis_source instead
                if(sourceSignature !== undefined && sourceSignature != sig) {
                    diagnosis_hasDifferentSignatures = true;
                    break;
                }
                sourceSignature = sig
            }
        }
        if(diagnosis_hasDifferentSignatures) {
            diagnosis_declaredSuffix = `The callback was handed up in multiple locations, which declared it with different parameter types. Therefore, all have to be validated. Locations:\n`;
            // TODO: use vs.meta.arguments.diagnosis_source instead
            diagnosis_declaredSuffix+= diagnosis.allValidationSpots.map(vs => `${diag_sourceLocation(vs.meta.diagnosis_source, true)}${vs.trim?" <-- extra properties get trimmed off":""}${vs === validationSpot?" <-- this one failed validation!":""}`).join("\n");
            if(diagnosis.plusOthers) {
                diagnosis_declaredSuffix+=`\n...plus ${diagnosis.plusOthers} other place(s), which don't require validation`;
            }
        }
        else {
            diagnosis_declaredSuffix = `The callback's parameters were declared in ${diag_sourceLocation(meta.diagnosis_source, true)}`; // TODO: use vs.meta.arguments.diagnosis_source instead
        }

        // Handle invalid number of arguments:
        if(validationResult.errors.length == 1 && validationResult.errors[0].path === "$input") {
            throw new Error(`Invalid number of arguments for the callback function.\n${diagnosis_declaredSuffix}`); // Hope that matches with the if condition
        }

        // Compose errors into readable messages:
        // TODO: This is currently not the proper implementation (copyed from validteResult). Do like in ServerSession#validateMethodArguments.
        const readableErrors: string[] = validationResult.errors.map(error => {
            const improvedPath = error.path.replace(/^\$input/,"<result>")
            return `${improvedPath !== "<result>"?`${improvedPath}: `: ""}expected ${error.expected} but got: ${diagnisis_shortenValue(error.value)}`
        })

        const separateLines = readableErrors.length > 1;
        throw new Error(`Invalid argument(s) for callback function:${separateLines ? "\n" : " "}${readableErrors.join("\n")}\n${diagnosis_declaredSuffix}`);
    }


    /**
     * Unregister and inform the client
     * @param clientCallback
     */
    freeClientCallback(clientCallback: ClientCallback) {
        this.clientCallbacks.delete(clientCallback.id);
        this.sendMessage({type: "channelItemNotUsedAnymore", payload: {id: clientCallback.id, time: this.lastSequenceNumberFromClient}});
    }

    /**
     * Called by the client either
     * - A initially on a new connection
     * - B or after it is flagged outdated by the validator here and the client re-fetched it
     * - C or after a ServerSession method, called here, has written to fields and ordered the client to transfer it to the http side and re-fetched it from there (clean commit, to be safer against connection interruptions)
     * - D or after a ServerSession method, called here wanted to write to fields and saw that the session is still uninitialized (undefined) (no lazy cookie sent yet) and ordered... like C
     * - E or after the browser detected a change to the http cookie and re-fetched it (in the middle / state is not "outdated" here)
     * @param encryptedGetCookieSession_answer
     * @protected
     */
    protected setCookieSession(encryptedGetCookieSession_answer: unknown) {
        const answer: GetCookieSessionAnswerToken = this.server.server2serverDecryptToken(encryptedGetCookieSession_answer as any, "GetCookieSessionAnswerToken")
        // Validate:
        if(answer.question.serverSocketConnectionId !== this.id) {
            throw new Error("Question was not for this connection");
        }
        const newCookieSession = answer.cookieSession;
        if(answer.question.forceInitialize && !newCookieSession) {
            throw new Error("not initialized")
        }
        if(newCookieSession && (!newCookieSession.id || newCookieSession.version === undefined)) {
            throw new Error("answer.cookieSession.id/version not set");
        }

        // Some more validation check for user friendlyness, but they don't contribute to security (this does the validator). Without validator there would be other ways to sneak around these checks (i.e. with resetting the cookie first, or using another connection):
        if(this.cookieSession === undefined) { // New session ?
        }
        else if(this.cookieSession === "outdated") {
        }
        else if(newCookieSession === undefined) { // Reset (i.e. after logout) or after timeout ?
        }
        else if(this.cookieSession.id !== newCookieSession.id) { // Newer session ? I.e. a new session was created after a reset or a timeout ?
        }
        else { // Same session ?
            if(this.cookieSession.version === newCookieSession.version) { // same version, but it could still have different content: I.e. an attacker from a second socket connection created it. This way, he could achieve a 2 step progression before it gets rolled back, which is not what we want to allow.
                return; // Just return, don't set the connection into error state. The next failed validation + dropped_CookieSessionIsOutdated cycle will flush this out
            }
            if(this.cookieSession.version > newCookieSession.version) { // Version conflict or a replay attack ?
                return; // Just return, don't set the connection into error state. The next failed validation + dropped_CookieSessionIsOutdated cycle will flush this out
            }
        }

        // Successfully update:
        this.cookieSession = newCookieSession
    }

    /**
     *
     * @param args Raw arguments from the call
     * @protected
     */
    protected updateHttpSecurityProperties(encryptedAnswer: unknown) {

        // Decrypt answer:
        const answer: GetHttpSecurityProperties_answer = this.server.server2serverDecryptToken(encryptedAnswer as any, "GetHttpSecurityProperties_answer");

        // Validate answer:
        if(answer.question.serverSocketConnectionId !== this.id) {
            throw new Error("Question was not for this connection");
        }

        // Obtain serverSessionClass:
        const serverSessionClass = this.server.serverSessionClasses.get(answer.question.serverSessionClassId);
        if(!serverSessionClass) {
            throw new Error(`ServerSession class was not found: ${answer.question.serverSessionClassId}`)
        }

        // Update the security properties:
        if(this.useSecurityGroups) {
            const securityGroup = this.server.getSecurityGroupOfService(serverSessionClass);
            this.securityGroup2SecurityPropertiesOfHttpRequest!.set(securityGroup, answer.result);
        }
        else {
            this.serverSessionClass2SecurityPropertiesOfHttpRequest!.set(serverSessionClass, answer.result);
        }
    }

    /**
     * Adds an listener that gets called on close / disconnect
     * @param callback
     */
    public onClose(callback: (reason?: CloseReason) => void) {
        this.onCloseListeners.add(callback);
    }

    /**
     * Like onclose, but this time not a function but some instance that can be weakly referenced.
     * Currently not working !! See https://github.com/bogeeee/restfuncs/issues/9
     * @param handler
     */
    public onCloseWeak(handler: OnCloseHandlerInterface) {
        this.weakOnCloseListeners.add(handler);
    }

    public close(reason?: CloseReason) {
        this.socket.close();
        this.closeReason = reason;
        this.handleClose();
    }

    protected handleClose(reason?: CloseReason) {
        this.methodDownCallPromises.forEach(p => p.reject(diagnosis_closeReasonToError(reason))); // Reject outstanding method calls. Not strongly decided, whether this should go before or after the following lines, but may be it' better to properly complete (with error) a callForSure in a ClientCallbackSet before such one is cleaned up.
        this.onCloseListeners.forEach(l => l(reason)); // Call listeners
        this.weakOnCloseListeners.forEach(h => h.handleServerSocketConnectionClosed(this, reason)); // Call weak listeners
    }


    /**
     * See also: {@link #closeReason}
     */
    public isClosed() {
        return this.socket.readyState === "closing" || this.socket.readyState === "closed";
    }

    checkClosed() {
        if(this.isClosed()) {
            if(!this.closeReason) {
                this.closeReason = new Error("Socket was closed");
            }
            throw fixErrorForJest(new Error(`Connection closed: ${diagnosis_closeReasonToString(this.closeReason)}, see cause`, {cause: this.closeReason}));
        }
    }
}

export type CloseReason = {message: string, obj?: object} | Error
export function diagnosis_closeReasonToString(reason?: CloseReason) {
    if(reason === undefined) {
        return undefined;
    }
    if(reason instanceof Error) {
        return reason.message;
    }
    return reason.message?(`${reason.message}` + (reason.obj?` obj=${diagnisis_shortenValue(reason.obj)}`:"")):diagnisis_shortenValue(reason.obj);
}
export function diagnosis_closeReasonToError(reason?: CloseReason, hint?: string): Error | undefined {
    if((reason as any)?.obj instanceof Error) {
        reason = (reason as any).obj;
    }
    if(reason === undefined) {
        return new Error (`Connection was closed.${hint?` Hint: ${hint}`:""}`);
    }
    if(reason instanceof Error) {
        if(hint) {
            return fixErrorForJest(new Error(`${reason.message}. Hint: ${hint}`, {cause: reason}));
        }
        return reason;
    }

    let message = reason.message?(`${reason.message}` + (reason.obj?` obj=${diagnisis_shortenValue(reason.obj)}`:"")):diagnisis_shortenValue(reason.obj);
    if(hint) {
        message = `${message}. Hint: ${hint}`;
    }
    return new Error(message);
}

export type OnCloseHandlerInterface = { handleServerSocketConnectionClosed: ((conn: ServerSocketConnection, reason?: CloseReason) => void) };

type ValidationSpot = { meta: RemoteMethodCallbackMeta, trim: boolean };