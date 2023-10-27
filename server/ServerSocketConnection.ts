import crypto from "node:crypto";
import {SecurityPropertiesOfHttpRequest, ServerSession} from "./ServerSession";
import {RestfuncsServer, SecurityGroup} from "./Server";
import {Socket} from "engine.io";
import {
    Socket_Client2ServerMessage,
    Socket_MethodCall,
    Socket_MethodCallResult,
    Socket_Server2ClientMessage
} from "restfuncs-common";
import _ from "underscore";
import {Readable} from "node:stream";
import {CommunicationError, isCommunicationError} from "./CommunicationError";
import {fixErrorStack} from "./Util";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";

export class ServerSocketConnection {
    server: RestfuncsServer
    socket: Socket

    /**
     * The raw cookie-session values that were obtained from a http call.
     * Lazy / can be undefined if no session-cookie was send. I.e the user did not yet login
     */
    cookieSession?: Record<string, unknown>

    //cache_allowedSecurityGroupIds = new Set<string>(); // TODO: implement faster approving

    /**
     *
     */
    securityGroup2SecurityPropertiesOfHttpRequest?: Map<SecurityGroup, SecurityPropertiesOfHttpRequest>

    serverSessionClass2SecurityPropertiesOfHttpRequest?: Map<typeof ServerSession, SecurityPropertiesOfHttpRequest>


    constructor(server: RestfuncsServer, socket: Socket) {
        this.server = server;
        this.socket = socket;

        if(this.server.serverOptions.socket_requireAccessProofForIndividualServerSession) {
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
        this.socket.close()
    }

    onInstallSession() {

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

        // Switch on type:
        if(message.type === "methodCall") {
            this.handleMethodCall(message.payload as Socket_MethodCall /* will be validated in method*/)
        }
        else if(message.type === "getVersion") {
            // Leave this for future extensibility / probing feature flags (don't throw an error)
        }
        else {
            throw new Error(`Unhandled message type: ${message.type}`)
        }

    }

    /**
     *
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

        const sendResult = (callResult: Omit<Socket_MethodCallResult, "callId">) => {
            const payload: Socket_MethodCallResult = {
                ...callResult,
                callId: methodCall.callId
            }
            this.sendMessage({type: "methodCallResult", payload});
        }

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

            // Special method:
            if (methodCall.methodName === "setHttpCookieSessionAndSecurityProperties") {
                throw new Error("TODO: handle")
            }

            // Regular calls:
            // Validate:
            if (!methodCall.serverSessionClassId) {
                throw new Error("methodCall.serverSessionClassId not set");
            }

            const serverSessionClass = this.server.serverSessionClasses.get(methodCall.serverSessionClassId);
            if(!serverSessionClass) {
                throw new Error(`A ServerSessionClass with the id: '${methodCall.serverSessionClassId}' is not registered.`);
            }
            const cookieSession = this.cookieSession || {}

            // Determine security properties (request fetch if necessary):
            let securityPropertiesOfHttpRequest: SecurityPropertiesOfHttpRequest | undefined
            if(this.server.serverOptions.socket_requireAccessProofForIndividualServerSession) {
                securityPropertiesOfHttpRequest = this.serverSessionClass2SecurityPropertiesOfHttpRequest!.get(serverSessionClass);
            }
            else {
                securityPropertiesOfHttpRequest = this.securityGroup2SecurityPropertiesOfHttpRequest!.get(serverSessionClass.securityGroup);
            }
            if(!securityPropertiesOfHttpRequest) {
                // TODO: request fetch
                // @ts-ignore
                securityPropertiesOfHttpRequest = {};
            }

            // @ts-ignore No Idea why we get a typescript error here
            const enhancementProps: Partial<ServerSession> = {socketConnection: this};

            (async () => {
                try {
                    const {result, modifiedSession} = await serverSessionClass.doCall_outer(cookieSession, securityPropertiesOfHttpRequest as SecurityPropertiesOfHttpRequest, methodCall.methodName, methodCall.args, enhancementProps, {})

                    if (modifiedSession) {
                        throw new Error("Session was modified. TODO: implement");
                    }

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

                    sendResult({
                        result,
                        httpStatusCode: 200
                    })
                }
                catch (caught) {
                    if(caught instanceof Error) {
                        const httpStatusCode = ( isCommunicationError(caught) && (<CommunicationError>caught).httpStatusCode || 500);

                        fixErrorStack(caught)
                        let error = serverSessionClass.logAndConcealError(caught, {socketConnection: this});

                        sendResult({
                            error: error,
                            httpStatusCode
                        });
                    }
                    else { // Something other than an error was thrown ? I.e. you can use try-catch with "things" as as legal control flow through server->client
                        // Just send it:
                        sendResult({
                            result: caught,
                            httpStatusCode: 550 // Indicate "throw legal value" to the client
                        });
                    }
                }
            })()

        }
        catch (e: any) { // Catch common error (before we could execute the call)
            sendResult({
                error: {
                    message: e?.message || e,
                    name: e?.name,
                },
                httpStatusCode: 500
            });
        }
    }
}