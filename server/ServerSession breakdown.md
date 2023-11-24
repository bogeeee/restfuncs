Lines were removed, to help you understand the structure:
````typescript
export class ServerSession implements IServerSession {
    // ...

    /**
     * Creates a handler that allows all (instance-) @remote methods to be called by http. This can be by the restfuncs client.
     */
    static createExpressHandler(): Router {

        this.checkOptionsValidity(this.options); // Do some global checks:

        this.server.registerServerSessionClass(this); // Make sure, this is registered

        const router = express.Router();

        router.use(express.raw({limit: Number.MAX_VALUE, inflate: false, type: req => true})) // parse application/brillout-json and make it available in req.body

        router.use(async (req, res, next) => {
            let acceptedResponseContentTypes = ... // obtain

            let cleanupStreamsAfterRequest = undefined

            /**
             * Http-sends the result, depending on the requested content type:
             */
            const sendResult = (result: unknown, diagnosis_methodName?: string) => {
                const contextPrefix = diagnosis_methodName ? `${diagnosis_methodName}: ` : ""; // Reads better. I.e. the user doesnt see on first glance that the error came from the getIndex method
                // ...
                const [contentTypeFromCall, contentTypeOptionsFromCall] = parseContentTypeHeader(contentTypeHeader);

                if(contentTypeFromCall == "application/brillout-json") {
                    res.send(brilloutJsonStringify(result));
                }
                else if(contentTypeFromCall == "application/json") {
                    res.json(result);
                }
                else {
                    //...
                }
            }


            try {
                // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
                res.header("...");
                // ...

                if(req.method !== "GET" && req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE" && req.method !== "OPTIONS") {
                    throw new CommunicationError("Unhandled http method: " + req.method)
                }

                const origin = getOrigin(req);
                const originAllowed =  originIsAllowed({origin, destination: getDestination(req), allowedOrigins: this.options.allowedOrigins}, diagnosis_originNotAllowedErrors) || this.options.devDisableSecurity

                // Answer preflights:
                if(req.method === "OPTIONS") {
                    if(originAllowed) {
                        if(req.header("Access-Control-Request-Method")) { // Request is a  CORS preflight (we don't care which actual method) ?
                            res.header("Access-Control-Allow-...", "...")
                            // ...
                            res.status(204);
                        }
                    }
                    else {
                        throw new CommunicationError("...");
                    }

                    res.end();
                    return;
                }

                // Add cors header:
                if(originAllowed) {
                    // Send CORS headers (like preflight)
                    res.header("Access-Control-Allow-Origin", origin);
                    res.header("Access-Control-Allow-Credentials", "true")
                }

                // ...

                // Obtain cookieSession:
                let cookieSession = this.getFixedCookieSessionFromRequest(req);

                // Validate cookieSession (i.e. by external validation database):
                if(cookieSession && !(await this.server.cookieSessionIsValid(cookieSession))) { // cookieSession is invalid ?
                    await this.regenerateExpressSession(req);
                    cookieSession = this.getFixedCookieSessionFromRequest(req);
                    // ...
                }

                // retrieve method name (i.e. I.e GET user -> "getUser"):
                // ...
                let methodNameFromPath = ... // extract method name from req.path
                const remoteMethodName = this.getMethodNameForCall(req.method, this.prototype, methodNameFromPath);
                // ...

                // Collect params / metaParams,...:
                const {methodArguments, metaParams, cleanupStreamsAfterRequest: c} = this.collectParamsFromRequest(remoteMethodName, req);
                cleanupStreamsAfterRequest = c;

                // Collect / pre-compute securityProperties:
                const userAgent = req.header("User-Agent");
                const securityPropertiesOfRequest: SecurityPropertiesOfHttpRequest = {
                    ...metaParams,
                    httpMethod: req.method,
                    origin,
                    destination: getDestination(req),
                    browserMightHaveSecurityIssuseWithCrossOriginRequests: userAgent?browserMightHaveSecurityIssuseWithCrossOriginRequests({userAgent: userAgent}):false,
                    couldBeSimpleRequest: couldBeSimpleRequest(req)
                }

                // ...

                // Do the call:
                let { result, modifiedSession} = await this.doCall_outer(cookieSession, securityPropertiesOfRequest, remoteMethodName, methodArguments, {req, res, securityProps: securityPropertiesOfRequest}, {});

                if(modifiedSession) {
                    if(modifiedSession.commandDestruction) {
                        await this.destroyExpressSession(req, res);
                    }
                    else {
                        this.updateAndSendReqSession(modifiedSession, req, res);
                    }
                    // Don't safe in session validator yet. Sending the response to the client can still fail. It's updated there before the next call.
                }

                sendResult(result, remoteMethodName);
            }
            catch (caught) {
                if(caught instanceof Error) {
                    res.status( isCommunicationError(caught) && (<CommunicationError>caught).httpStatusCode || 500);

                    fixErrorStack(caught)
                    let error = this.logAndConcealError(caught, {req});

                    // Format error and send it:
                    acceptedResponseContentTypes.find((accept) => { // Iterate until we have handled it
                        if(accept == "application/json") {
                            res.json(error);
                        }
                        else {
                            //...
                        }
                        return true; // it was handled
                    });
                }
                else { // Something other than an error was thrown ? I.e. you can use try-catch with "things" as as legal control flow through server->client
                    res.status(550); // Indicate "throw legal value" to the client
                    sendResult(caught); // Just send it.
                }
            }
            finally {
                cleanupStreamsAfterRequest?.()
            }
        });

        return router;
    }

    

    /**
     * This method is the entry point that's called by both: http request and socket connection.
     * Does various stuff / look at the implementation. <p>Internal: Override {@link doCall} instead.</p>
     * @param call the properties that should be made available for the user during call time. like req, res, ...
     * @returns modifiedSession is returned, when a deep session modification was detected. With updated version field
     */
    static async doCall_outer(cookieSession: CookieSession | undefined, securityPropertiesOfHttpRequest: SecurityPropertiesOfHttpRequest, remoteMethodName: string, methodArguments: unknown[], call: ServerSession["call"], diagnosis: Omit<CIRIACS_Diagnosis, "isSessionAccess">) {

        // Check, if call is allowed if it would not access the cookieSession, with **general** csrfProtectionMode:
            // ...
        this.checkIfRequestIsAllowedCrossSite(securityPropertiesOfHttpRequest, this.options.csrfProtectionMode, this.options.allowedOrigins, cookieSession, remoteMethodName, {});

        // Instantiate a serverSession:
        const referenceInstance = this.referenceInstance; // Make sure that lazy field is initialized before creating the instance. At least this is needed for the testcases
        let serverSession: ServerSession = new this();

        serverSession.validateCall(remoteMethodName, methodArguments);
        
        {
            // *** Prepare serverSession for change tracking **
            // Create a deep clone of cookieSession: , because we want to make sure that the original is not modified. Only at the very end, when the call succeeded, the new session is committed atomically
            let cookieSessionClone = _.extend({}, cookieSession || {})// First, make all values own properties because structuredClone does not clone values from inside the prototype but maybe an express session cookie handler delivers its cookie values prototyped.
            cookieSessionClone = structuredClone(cookieSessionClone)

            _.extend(serverSession, cookieSessionClone);
        }

        const guardedServerSession = this.createGuardProxy(serverSession, securityPropertiesOfHttpRequest, this.options.allowedOrigins, remoteMethodName, diagnosis) // wrap session in a proxy that will check the security on actual session access with the csrfProtectionMode that is required by the **session**

        let result: unknown;
        try {
            // Execute the remote method (wrapped):
            await enhanceViaProxyDuringCall(guardedServerSession, {call}, async (enhancedServerSession) => { // make call (.req, .res, ...) safely available during call
                // Execute the remote method:
                if(ServerSession.prototype[remoteMethodName as keyof ServerSession]) { // Calling a ServerSession's own (conrol-) method. i.e. getWelcomeInfo()
                    // @ts-ignore
                    result = await enhancedServerSession[remoteMethodName](...methodArguments); // Don't pass your control methods through doCall, which is only for intercepting user's methods. Cause, i.e. intercepting the call and throwing an error when not logged in, etc should not crash our stuff.
                }
                else {
                    result = await enhancedServerSession.doCall(remoteMethodName, methodArguments); // Call method with user's doCall interceptor;
                }
            }, remoteMethodName);

            // Validate the result:
            if(this.getRemoteMethodOptions(remoteMethodName).validateResult !== false) {
                serverSession.validateResult(result, remoteMethodName);
            }
        }
        catch (e) {
            // Handle non-errors:
            // ...
            throw e;
        }

        // Check if (deeply) modified:
        const modified = ...

        let modifiedSession: Omit<CookieSession, "id"> | undefined = undefined;
        if(modified) {
            modifiedSession = {
                ...serverSession
            };
            this.increaseCookieSessionVersion(modifiedSession);
        }
        return {
            modifiedSession,
            result
        };
    }

    

    /**
     * Wildly collects the parameters. This method is only side effect free but the result may not be secure / contain evil input !
     *
     * For body->Readable parameters and multipart/formdata file -> Readble/UploadFile parameters, this will return before the body/first file is streamed and feed the stream asynchronously.
     * <p>You can override this as party of the Restfuncs API</p>
     * @see ServerSession#validateCall use this method to check the security on the result
     * @param methodName
     * @param req
     */
    protected static collectParamsFromRequest(methodName: string, req: Request) {
         // TODO: break down this method
    }

    /**
     * Allows you to intercept calls, by overriding this method.
     * You have access to this.call.req, this.call.res as usual.
     * <p>
     *     Calls to Restfuncs internal control methods do not go though this method.
     * </p>
     */
    protected async doCall(methodName: string, args: unknown[]) {
        // @ts-ignore
        return await this[methodName](...args) // Call the method
    }

    /**
     * Browser CSRF protection:
     * Checks, that we can trust the request to be from an allowed origin, so that it can't make unallowed cross-site write operations.
     */
    private static checkIfRequestIsAllowedCrossSite(reqSecurityProps: SecurityPropertiesOfHttpRequest, enforcedCsrfProtectionMode: CSRFProtectionMode | undefined, allowedOrigins: AllowedOriginsOptions, cookieSession: Pick<SecurityRelevantSessionFields,"corsReadTokens" | "csrfTokens">, remoteMethodName: string, diagnosis: CIRIACS_Diagnosis): void {
        // A breakdown of this method can be found [here](Security concept.md#csrf-protection)
        
        //if a corsReadToken is needed, this is signaled by a: throw new CommunicationError(`...`, {httpStatusCode: 480})
    }

}

````