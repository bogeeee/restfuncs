Lines were removed, to help you understand the structure:
````typescript
export class ServerSocketConnection {
   
    /**
     * The raw cookie-session values that were obtained from a http call.
     * Lazy / can be undefined, if no session-cookie was yet set. I.e the user did not yet login
     * "syncing" = we know that we don't have a valid info here. Rejects further ServerSession method calls then.
     */
    cookieSession?: CookieSession | "outdated" = "outdated"

    //cache_allowedSecurityGroupIds = new Set<string>(); // TODO: implement faster approving. Invalidate, when the cookie session changes (cookieSession's csrfProtectionMode, tokens vs. SecurityPropertiesOfHttpRequest) )

    // One of these 2 maps will be used
    securityGroup2SecurityPropertiesOfHttpRequest?: Map<SecurityGroup, Readonly<SecurityPropertiesOfHttpRequest>>
    serverSessionClass2SecurityPropertiesOfHttpRequest?: Map<typeof ServerSession, Readonly<SecurityPropertiesOfHttpRequest>>

   

    constructor(server: RestfuncsServer, socket: Socket) {
        // ...
        socket.on("message", (data: string | Buffer) => {
            const message = this.deserializeMessage(data);
            try {
                this.handleMessage(message as Socket_Client2ServerMessage /* will be validated in method*/);
            }
            catch (e: any) {
                // ...
            }
        })

        const initMessage: Socket_Server2ClientInit = {
            cookieSessionRequest: this.server.server2serverEncryptToken({
                serverSocketConnectionId: this.id, forceInitialize: false
            }, "GetCookieSession_question")
        }
        this.sendMessage({type: "init", payload: initMessage})
    }

    protected sendMessage(message: Socket_Server2ClientMessage) {
        this.socket.send(this.serializeMessage(message));
    }

    /**
     *
     * @param message The raw, evil value from the client.
     * @protected
     */
    protected handleMessage(message: Socket_Client2ServerMessage) {
        // Validate input:
        // ...

        // Switch on type:
        if(message.type === "methodCall") {
            this.handleMethodCall(message.payload as Socket_MethodCall /* will be validated in method*/)
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
            // ...
        }
    }

    /**
     *
     * @param methodCall the raw, evil value from the client.
     * @protected
     */
    protected handleMethodCall(methodCall: Socket_MethodCall) {
        // Validate the type:
        // ...


        /**
         * This function definitely returns a (one) Socket_MethodCallResult. This is the safer arrangement than calling this.sendMessage from multiple places
         */
        const handleMethodCall_inner = async (): Promise<Omit<Socket_MethodCallResult, "callId">> => {
            try { // We can properly answer errors from here on

                // Continue validating:
                // ...
                
                // Validate cookieSession:
                if(this.cookieSession === "outdated") {
                    return {
                        status: "dropped_CookieSessionIsOutdated"
                    }
                }
                if(this.cookieSession && !(await this.server.cookieSessionIsValid(this.cookieSession))) { //Ask the JWT validator (database) -> Not valid ? Either a timeout or a newer version already exists
                    this.cookieSession = "outdated"
                    return {
                        status: "dropped_CookieSessionIsOutdated",
                    }
                }

                // Obtain serverSessionClass:
                const serverSessionClass = this.server.serverSessionClasses.get(methodCall.serverSessionClassId);
                // ...

                // Determine security properties (request fetch if necessary):
                let securityPropertiesOfHttpRequest = this. .... // get security properties that were already stored here 
                if (!securityPropertiesOfHttpRequest) {
                    // Block call and request the client to send those securityProperties first:
                    return {
                        needsHttpSecurityProperties: {
                            question: this.server.server2serverEncryptToken({
                                serverSocketConnectionId: this.id,
                                serverSessionClassId: serverSessionClass.id,
                            }, "GetHttpSecurityProperties_question"),
                            syncKey: "..."
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
                    // See ServerSession breakdown.md for doCall_outer
                    const { result, modifiedSession} = await serverSessionClass.doCall_outer(this.cookieSession, securityPropsForThisCall, methodCall.methodName, methodCall.args, {socketConnection: this, securityProps: securityPropsForThisCall}, {})

                    // Check if result is of illegal type:
                    // ...

                    if (modifiedSession) {
                        if(!this.cookieSession) { // New session ?                            
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
                        // ...


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
                // ...
            }
        }

        // Send the the result from handleMethodCall_inner:
        (async () => {
            const payload: Socket_MethodCallResult = {
                callId: methodCall.callId,
                ... await handleMethodCall_inner()
            }
            this.sendMessage({type: "methodCallResult", payload});
        })();
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
        // ...
        const newCookieSession = answer.cookieSession;
        // Validate
        // ...

        // Some more validation check for user friendlyness, but they don't contribute to security (this does the validator). Without validator there would be other ways to sneak around these checks (i.e. with resetting the cookie first, or using another connection):
        // ...

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
        // ...

        // Obtain serverSessionClass:
        const serverSessionClass = this.server.serverSessionClasses.get(answer.question.serverSessionClassId);
        // ...

        // Update the security properties:
        if(this.useSecurityGroups) {
            const securityGroup = this.server.getSecurityGroupOfService(serverSessionClass);
            this.securityGroup2SecurityPropertiesOfHttpRequest!.set(securityGroup, answer.result);
        }
        else {
            this.serverSessionClass2SecurityPropertiesOfHttpRequest!.set(serverSessionClass, answer.result);
        }
    }
}
````