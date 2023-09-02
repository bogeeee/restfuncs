import express, {Request, Response, Router} from "express";
import _ from "underscore";
import {reflect, ReflectedMethod, ReflectedMethodParameter} from "typescript-rtti";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import URL from "url"
import {
    browserMightHaveSecurityIssuseWithCrossOriginRequests,
    Camelize, cloneError, couldBeSimpleRequest, createProxyWithPrototype,
    diagnisis_shortenValue,
    diagnosis_isAnonymousObject,
    diagnosis_looksLikeHTML, diagnosis_looksLikeJSON,
    enhanceViaProxyDuringCall, ERROR_PROPERTIES,
    errorToHtml,
    errorToString,
    ErrorWithExtendedInfo,
    fixErrorStack, fixTextEncoding, getDestination, getOrigin,
    parseContentTypeHeader,
    shieldTokenAgainstBREACH, shieldTokenAgainstBREACH_unwrap
} from "./Util";
import escapeHtml from "escape-html";
import crypto from "node:crypto"
import {getServerInstance, PROTOCOL_VERSION, RestfuncsServer, Server2ServerEncryptedBox} from "./Server";
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";
import {Readable} from "node:stream";
import {isRestError, RestError} from "./RestError";
import busboy from "busboy";

export function isTypeInfoAvailable(service: object) {
    const r = reflect(service);

    // *** Some heuristic checks: (the rtti api currently has no really good way to check it)
    // TODO: improve checks for security reasons !

    /*
    if(r.methods.length === 0) {
        return false;
    }
    // Still this check was not enough because we received  the methods of the prototype
    */

    if(r.getProperty("xxyyyyzzzzzdoesntExist") !== undefined) { // non existing property reported as existing ?
        return false;
    }

    return true
}


/**
 * Throws an exception if you're not allowed to call the method from the outside
 * @param reflectedMethod
 */
function checkMethodAccessibility(reflectedMethod: ReflectedMethod) {
    if(reflectedMethod.isProtected) {
        throw new RestError("Method is protected.")
    }
    if(reflectedMethod.isPrivate) {
        throw new RestError("Method is private.")
    }

    // The other blocks should have already caught it. But just to be safe for future language extensions we explicitly check again:
    if(reflectedMethod.visibility !== "public") {
        throw new RestError("Method is not public")
    }
}

/**
 * Throws an exception if args does not match the parameters of reflectedMethod
 * @param reflectedMethod
 * @param args
 */
export function checkParameterTypes(reflectedMethod: ReflectedMethod, args: Readonly<any[]>) {
    // Make a stack out of args so we can pull out the first till the last. This wqy we can deal with ...rest params
    let argsStack = [...args]; // shallow clone
    argsStack.reverse();

    const errors: string[] = [];
    function validateAndCollectErrors(parameter: ReflectedMethodParameter, arg: any) {
        const collectedErrorsForThisParam: Error[] = [];
        const ok = parameter.type.matchesValue(arg, collectedErrorsForThisParam); // Check value
        if (!ok || collectedErrorsForThisParam.length > 0) {
            errors.push(`Invalid value for parameter ${parameter.name}: ${diagnisis_shortenValue(arg)}${collectedErrorsForThisParam.length > 0?`. Reason: ${collectedErrorsForThisParam.map(e => e.message).join(", ")}`:""}`);
        }
    }

    for(const i in reflectedMethod.parameters) {
        const parameter = reflectedMethod.parameters[i];
        if(parameter.isOmitted) {
            throw new RestError("Omitted arguments not supported")
        }
        if(parameter.isRest) {
            argsStack.reverse();

            validateAndCollectErrors(parameter, argsStack);

            argsStack = [];
            continue;
        }
        if(parameter.isBinding) {
            throw new RestError(`Runtime typechecking of destructuring arguments is not yet supported`)
        }

        const arg =  argsStack.length > 0?argsStack.pop():undefined;

        // Allow undefined for optional parameter:
        if(parameter.isOptional && arg === undefined) {
            continue;
        }

        validateAndCollectErrors(parameter, arg);
    }

    if(argsStack.length > 0) {
        throw new RestError(`Too many arguments. Expected ${reflectedMethod.parameters.length}, got ${args.length}`)
    }

    if(errors.length > 0) {
        throw new RestError(errors.join("; "))
    }
}


export type RegularHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ParameterSource = "string" | "json" | null; // Null means: Cannot be auto converted

export type AllowedOriginsOptions = undefined | "all" | string[] | ((origin?: string, destination?: string) => boolean);
export type RestfuncsOptions = {
    /**
     * If using multiple RestfuncsServers(=apps), you must explicitly specify which one this service belongs to.
     */
    app?: RestfuncsServer


    /**
     * Only for standalone server
     * TODO: remove
     */
    path?: string

    /**
     * Enable basic auth by specifying a function that returns true if username+password is allowed.
     * <p>
     * Setting it to "ignoresHeader" confirms that your code inside this service does not evaluate the Basic Auth http header (whilst it was intended for other services). Therefore restfuncs will not complain when using a client-decided CSRF protection mode.
     * </p>
     * TODO: implement. Maybe instead of ignoresHeader, react on a hook when the header is accessed.
     */
    basicAuth?: ((user: string, password: string) => boolean) | "ignoresHeader"


    /**
     * TODO: use global disableSecurity option
     * Enable checking your func's arguments at runtime (shielding).
     *
     * To make it work, See https://github.com/bogeeee/restfuncs#runtime-arguments-typechecking-shielding-against-evil-input
     * See also the security notes there.
     *
     * When undefined, arguments typechecking will be tried but a warning is issued when not possible. It's recommended to explicitly enable this.
     */
    checkArguments?: boolean

    /**
     * Whether errors during call should be logged to the console.
     * You can supply a logger function
     * Default: true
     */
    logErrors?: boolean | ((message: string, req?: Request) => void)

    /**
     * Whether to show/expose error information to the client:
     * - true: Exposes ALL error messages + stacks. Enable this for development.
     * - "messagesOnly": Exposes only the message/title + class name. But no stack or other info.
     * - "RestErrorsOnly" (default): Like messageOnly but only for subclasses of {@see RestError}. Those are intended to aid the interface consumer.
     * - false: No information is exposed. The client will get a standard Error: "Internal server error".
     *
     *  User defined SUB- classes of {@see RestError} will always fall through this restriction and have their message, name and custom properties exposed.
     *  I.e. You could implement a 'class NotLoggedInException extends RestError' as in indicator to trigger a login form.
     */
    exposeErrors?: true | "messagesOnly" | "RestErrorsOnly" | false

    /**
     * Web browser security: <strong>Which origins are allowed to make calls ?</strong>
     *
     * These origins will share the credentials (cookies, basic auth, ...) and therefore the user's session !
     *
     * Change this option if you:
     *  - Host the backend and frontend on different (sub-) domains.
     *  - Provide authentication methods to other web applications.
     *  - Consume authentication responses from 3rd party authentication providers. I.e. form- posted SAML responses.
     *  - Provide client side service methods to other web applications (that need the current user's session).
     *  - Have a reverse proxy in front of this web app and you get an error cause the same-origin check fails for simple, non preflighted, requests like form posts. Alternatively check the trust proxy settings: http://expressjs.com/en/4x/api.html#app.settings.table (currently this does not work properly with express 4.x)
     *
     * Values:
     * - undefined (default): Same-origin only
     * - string[]: List the allowed origins: http[s]://host[:port]. Same-origin is always implicitly allowed
     * - "all": No restrictions
     * - function: A function (origin, destination) that returns true if it should be allowed. Args are in the form: http[s]://host[:port]
     *
     * <i>Technically, functions, which you flagged as {@link safe}, are still allowed to be called by [simple](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests) GET requests without an origin check.</i>
     *
     */
    allowedOrigins?: AllowedOriginsOptions



    /**
     * <p>
     * When sharing resources across origins, browsers make a CORS preflight http request (OPTIONS header) to check if that url from is allowed allowed from that origin.
     * If not, the (actual) request will not executed (with another CORS header check is the result is allowed to be read).
     * </p>
     * <p>
     * All this works fine, but strictly speaking, according to the CORS spec. The preflights are only there to see if the CORS protocol is understood.
     * This means, for state-changing requests, we can't rely on the browser making preflights and if the result arrives at the browser, telling it not to be read, it's already too late. The method has been executed and could abused as a CSRF.
     * </p>
     *
     * </p>
     * To still allow interoperability, you can:
     * - if the method is read only, see {@link safe()}.
     * - implement the access token logic yourself, see {@link Service.proofRead()}
     * - disable this feature and trust on browsers to make preflights and bail if they fail.
     *
     * Note: For client developers with tokenized modes: You may wonder wonder why some requests will still pass without token checks. They may be already considered safe according the the origin/referrer headers or for @safe methods.
     * If you want this stricter while developing your clients and raise early errors, enable the {@link devForceSessionCSRFProtection} and {@link devForceTokenCheck} developlment options.
     *
     * Default: true
     */
    csrfProtectionMode?: CSRFProtectionMode

    /**
     * <p>Many requests are usually allowed to go through without requiring the corsReadToken check. I.e if host/origin/referer headers are present or if no session is accessed at all.
     * </p>
     * <p>
     * Here you can force the check for every request (except {@link safe() safe methods}), so you'll <strong>see early in the development if the token was not properly passed</strong>.
     * </p>
     */
    devForceTokenCheck?: boolean




    /**
     * Enable/disable file uploads through http multipart
     * If not needed, you may disable this to have one less http parser library (busboy) involved (security).
     * TODO: do we need this flag ?
     * undefined (default) = auto detect if really needed by scanning for functions that have Buffer parameters
     */
    enableMultipartFileUploads?: boolean
}
export type CSRFProtectionMode = "preflight" | "corsReadToken" | "csrfToken"
/**
 * Values that are allowed to be set as meta parameters via header / query params / request body params.
 */
export const metaParameterNames = new Set<string>(["csrfProtectionMode", "corsReadToken", "csrfToken"])

export type SecurityRelevantSessionFields = {
    /**
     * Can be undefined if nothing has yet been written, or if the client(s) don't explicitly specify a mode
     */
    csrfProtectionMode?: CSRFProtectionMode

    /**
     * One for each service
     * Service id -> token
     */
    corsReadTokens?: Record<string, string>

    /**
     * One for each service
     *
     * Service id -> token
     */
    csrfTokens?: Record<string, string>
};

/**
 * Usage: app.use("/myAPI",
 */
export class Service {
    [index: string]: any

    /**
     * Uniquely identify this service. An id is needed to store corsReadTokens and csrfTokens in the session, bound to a certain service (imagine different services have different allowedOrigings so we can't have one-for-all tokens).
     * Normally the class name is used and not a random ID, cause we want to allow for multi-server environments with client handover
     */
    id: string = Service.generatedId(this)

    static options: RestfuncsOptions;

    /**
     * Lists the methods that are flagged as @safe
     * filled on annotation loading: for each concrete subclass such a static field is created
     */
    static safeMethods?: Set<string>

    /**
     * Those methods directly here on Service are allowed to be called
     */
    static whitelistedMethodNames = new Set(["getIndex", "getCorsReadToken"])

    /**
     * The currently running (express) request. See https://expressjs.com/en/4x/api.html#req
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
        // @ts-ignore // TODO: make req | undefined in 1.0 API
    protected req!: Request = null;

    /**
     * Response for the currently running (express) request. You can modify any header fields as you like. See https://expressjs.com/en/4x/api.html#res
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
     // @ts-ignore // TODO: make req | undefined in 1.0 API
    // TODO: rename to res
    protected resp!: Response = null;


    /**
     * The browser/client session (for the currently running request). You can add any user defined content to it.
     * What you set as initial value here will also be the initial value of EVERY new session. Note that this initial session is not deeply cloned.
     *
     * When restfuncs is used with express, you must install the session handler in express yourself (follow the no-sessionhandler errormessage for guidance).
     *
     * Note: Only available during a request and inside a service method (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected session?: {} = {};

    /**
     * Internal
     * @private
     */
    _sessionPrototype?: object;

    /**
     *
     * @param options
     * @param id You must specify it, if you have multiple instances of the same class
     */
    constructor() {
        this.checkIfIdIsUnique();

        // Safety: Any non-null value for these may be confusing when (illegally) accessed from the outside.
        // @ts-ignore
        this.req = null; this.resp = null; // TODO set to undefined in 1.0 API


    }

    /**
     * Pre checks some of the fields to give meaningful errors in advance.
     * @param options
     */
    protected static checkOptionsValidity(options: RestfuncsOptions) {
        function checkAllowedOrigins() {
            if (options.allowedOrigins === undefined) {
            } else if (_.isArray(options.allowedOrigins)) {
                options.allowedOrigins.forEach( (value) => {
                    if(!/^http(s)?:\/\/[^\/]*$/.test(value)) {
                        throw new Error(`Invalid entry in allowedOrigins: '${value}'. Make sure it matches http[s]://host[:port]`)
                    }
                })
            } else if (typeof options.allowedOrigins === "function") {
            } else if (options.allowedOrigins === "all") {
            } else {
                throw new Error("Invalid value for allowedOrigins: " + options.allowedOrigins)
            }
        }
        checkAllowedOrigins();

        // Warn/error if type info is not available:
        if(!isTypeInfoAvailable(new this)) {
            if(this.options.checkArguments) {
                throw new RestError("Runtime type information is not available.\n" +  this._diagnosisWhyIsRTTINotAvailable())
            }
            else if(this.options.checkArguments === undefined) {
                console.warn("**** SECURITY WARNING: Runtime type information is not available. This can be a security risk as your service method's arguments cannot be checked automatically !\n" + this._diagnosisWhyIsRTTINotAvailable())
            }
        }
    }

    /**
     * Creates a middleware/router to use with express.
     * @param service An object who's methods can be called remotely / are exposed as a rest service.
     */
    public static createExpressHandler(): Router {

        // Do some global checks:
        this.checkOptionsValidity(this.options);




        const enableMultipartFileUploads = this.options.enableMultipartFileUploads || (this.options.enableMultipartFileUploads === undefined && (!isTypeInfoAvailable(this) || this.mayNeedFileUploadSupport()))

        const router = express.Router();

        router.use(express.raw({limit: Number.MAX_VALUE, inflate: false, type: req => true})) // parse application/brillout-json and make it available in req.body

        router.use(async (req, resp, next) => {
            let acceptedResponseContentTypes = [...(req.header("Accept")?.split(",") || []), "application/json"]; // The client sent us a comma separated list of accepted content types. + we add a default: "application/json" // TODO: add options
            acceptedResponseContentTypes.map(value => value.split(";")[0]) // Remove the ";q=..." (q-factor weighting). We just simply go by order

            let cleanupStreamsAfterRequest: (() => void) | undefined = undefined

            /**
             * Http-sends the result, depending on the requested content type:
             */
            const sendResult = (result: any, diagnosis_methodName?: string) => {
                const contextPrefix = diagnosis_methodName ? `${diagnosis_methodName}: ` : ""; // Reads better. I.e. the user doesnt see on first glance that the error came from the getIndex method

                // Determine contentTypeFromCall: The content type that was explicitly set during the call via resp.contentType(...):
                const contentTypeHeader = resp.getHeader("Content-Type");
                if(typeof contentTypeHeader == "number" || _.isArray(contentTypeHeader)) {
                    throw new Error(`${contextPrefix}Unexpected content type header. Should be a single string`);
                }
                const [contentTypeFromCall, contentTypeOptionsFromCall] = parseContentTypeHeader(contentTypeHeader);

                if(contentTypeFromCall == "application/brillout-json") {
                    resp.send(brilloutJsonStringify(result));
                }
                else if(contentTypeFromCall == "application/json") {
                    resp.json(result);
                }
                else if(contentTypeFromCall) { // Other ?
                    if(typeof result === "string") {
                        resp.send(result);
                    }
                    else if(result instanceof Readable) {
                        if(result.errored) {
                            throw result.errored;
                        }
                        result.on("error", (err) => {
                            resp.end(this.logAndGetErrorLineForPasteIntoStreams(err, req));
                        })
                        result.pipe(resp);
                    }
                    else if(result instanceof ReadableStream) {
                        throw new RestError(`${contextPrefix}ReadableStream not supported. Please use Readable instead`)
                    }
                    else if(result instanceof ReadableStreamDefaultReader) {
                        throw new RestError(`${contextPrefix}ReadableStreamDefaultReader not supported. Please use Readable instead`)
                    }
                    else if(result instanceof Buffer) {
                        resp.send(result);
                    }
                    else {
                        throw new RestError(`For Content-Type=${contentTypeFromCall}, ${diagnosis_methodName || "you"} must return a result of type string or Readable or Buffer. Actually got: ${diagnisis_shortenValue(result)}`)
                    }
                }
                else { // Content type was not explicitly set in the call ?
                    if(result instanceof Readable || result instanceof ReadableStream || result instanceof ReadableStreamDefaultReader || result instanceof Buffer) {
                        throw new RestError(`${contextPrefix}If you return a stream or buffer, you must explicitly set the content type. I.e. via: this.resp?.contentType(...); `);
                    }

                    // Send what best matches the Accept header (defaults to json):
                    acceptedResponseContentTypes.find((accept) => { // Iterate until we have handled it
                        if (accept == "application/brillout-json") { // The better json ?
                            resp.contentType("application/brillout-json")
                            resp.send(brilloutJsonStringify(result));
                        }
                        else if(accept == "application/json") {
                            result = result!==undefined?result:null; // Json does not support undefined
                            resp.json(result);
                        }
                        else if(accept == "text/html") {
                            if(diagnosis_looksLikeHTML(result)) {
                                throw new RestError(`${contextPrefix}If you return html, you must explicitly set the content type. I.e. via: this.resp?.contentType(\"text/html; charset=utf-8\"); `);
                            }
                            return false;
                        }
                        else {
                            return false; // not handled ?
                        }
                        return true; // it was handled
                    });


                }
            }


            try {
                // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
                resp.header("Expires","-1");
                resp.header("Pragma", "no-cache");

                resp.header("restfuncs-protocol",  PROTOCOL_VERSION); // Let older clients know when the interface changed
                resp.header("Access-Control-Expose-Headers", "restfuncs-protocol")

                if(req.method !== "GET" && req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE" && req.method !== "OPTIONS") {
                    throw new RestError("Unhandled http method: " + req.method)
                }

                let allowSessionAccess = false;
                const origin = getOrigin(req);
                const diagnosis_originNotAllowedErrors: string[] = []
                const originAllowed = originIsAllowed({origin, destination: getDestination(req), allowedOrigins: this.options.allowedOrigins}, diagnosis_originNotAllowedErrors);
                // Answer preflights:
                if(req.method === "OPTIONS") {
                    if(originAllowed) {
                        if(req.header("Access-Control-Request-Method")) { // Request is a  CORS preflight (we don't care which actual method) ?
                            resp.header("Access-Control-Allow-Origin", origin)
                            resp.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,DELETE")
                            resp.header("Access-Control-Allow-Headers", ["content-type", "accept", "iscomplex", ...Array.from(metaParameterNames).map( v=> v.toLowerCase())].join(", "));
                            resp.header("Access-Control-Allow-Credentials", "true")

                            resp.header("Vary", "Origin")
                            //resp.header("Access-Control-Max-Age", "3600") // Stick with the defaults / pros + cons not researched

                            resp.status(204);
                        }
                    }
                    else {
                        throw new RestError(diagnosis_originNotAllowedErrors.join("; "));
                    }

                    resp.end();
                    return;
                }

                // Add cors header:
                if(originAllowed) {
                    // Send CORS headers (like preflight)
                    resp.header("Access-Control-Allow-Origin", origin);
                    resp.header("Access-Control-Allow-Credentials", "true")
                }

                // retrieve method name:
                const fixedPath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
                let methodNameFromPath = fixedPath.split("/")[0];
                const methodName = this.getMethodNameForCall(req.method, methodNameFromPath);
                if(!methodName) {
                    if(!methodNameFromPath) {
                        throw new RestError(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`)
                    }
                    throw new RestError(`No method candidate found for ${req.method} + ${methodNameFromPath}.`)
                }

                const {methodArguments, metaParams, cleanupStreamsAfterRequest: c} = this.collectParamsFromRequest(methodName, req, enableMultipartFileUploads);
                cleanupStreamsAfterRequest = c;


                // Collect / pre-compute securityRelevantRequestFields:
                const userAgent = req.header("User-Agent");
                const requestParams: SecurityRelevantRequestFields = {
                    ...metaParams,
                    httpMethod: req.method,
                    serviceMethodName: methodName,
                    origin,
                    destination: getDestination(req),
                    browserMightHaveSecurityIssuseWithCrossOriginRequests: userAgent?browserMightHaveSecurityIssuseWithCrossOriginRequests({userAgent: userAgent}):false,
                    couldBeSimpleRequest: couldBeSimpleRequest(req)
                }

                if(this.options.devForceTokenCheck) {
                    const strictestMode = this.options.csrfProtectionMode || (<SecurityRelevantSessionFields> req.session)?.csrfProtectionMode || requestParams.csrfProtectionMode; // Either wanted explicitly by server or by session or by client.
                    if(strictestMode === "corsReadToken" || strictestMode === "csrfToken") {
                        // Enforce the early check of the token:
                        this.checkIfRequestIsAllowedToRunCredentialed(requestParams, strictestMode, (origin) => false, <SecurityRelevantSessionFields> req.session, {
                            acceptedResponseContentTypes,
                            contentType: parseContentTypeHeader(req.header("Content-Type"))[0],
                            isSessionAccess: false
                        })
                    }
                }


                this.checkIfRequestIsAllowedToRunCredentialed(requestParams, this.options.csrfProtectionMode, this.options.allowedOrigins, <SecurityRelevantSessionFields> req.session, {acceptedResponseContentTypes, contentType: parseContentTypeHeader(req.header("Content-Type"))[0], isSessionAccess: false});

                let session = null;
                // @ts-ignore
                const reqSession = req.session as Record<string,any>|undefined;
                if(reqSession !== undefined) { // Express runs a session handler ?
                    session = createProxyWithPrototype(reqSession, this._sessionPrototype!); // Create the this.session object which is a proxy that writes/reads to req.session but shows this.session's initial values. This way we can comply with the session's saveUninitialized=true / privacy friendliness
                    session = this.createCsrfProtectedSessionProxy(session, requestParams, this.options.allowedOrigins, {acceptedResponseContentTypes, contentType: parseContentTypeHeader(req.header("Content-Type"))[0]}) // The session may not have been initialized yet and the csrfProtectionMode state can mutate during the call (by others / attacker), this proxy will check the security again on each actual access.
                }

                let result = await this.validateAndDoCall(methodName, methodArguments, {req, resp, session}, this.options);
                sendResult(result, methodName);
            }
            catch (caught) {
                if(caught instanceof Error) {
                    resp.status( isRestError(caught) && (<RestError>caught).httpStatusCode || 500);

                    fixErrorStack(caught)
                    let error = this.logAndConcealError(caught, req);

                    // Format error and send it:
                    acceptedResponseContentTypes.find((accept) => { // Iterate until we have handled it
                        if(accept == "application/json") {
                            resp.json(error);
                        }
                        else if(accept == "text/html") {
                            resp.contentType("text/html; charset=utf-8")
                            resp.send(`<!DOCTYPE html><html>${errorToHtml(error)}${"\n"}<!-- HINT: You can have JSON here when setting the 'Accept' header tp application/json.--></html>`);
                        }
                        else if(accept.startsWith("text/")) {
                            resp.contentType(`text/plain; charset=utf-8`)
                            resp.send(errorToString(error))
                        }
                        else {
                            return false; // not handled ?
                        }
                        return true; // it was handled
                    });
                }
                else { // Something other than an error was thrown ? I.e. you can use try-catch with "things" as as legal control flow through server->client
                    resp.status(550); // Indicate "throw legal value" to the client
                    sendResult(caught); // Just send it.
                }
            }
            finally {
                cleanupStreamsAfterRequest?.()
            }
        });

        return router;
    }



    public get server(): RestfuncsServer {
        if(this.options.app) {
            return this.options.app;
        }
        return getServerInstance();
    }

    /**
     * @return The / index- / home page
     */
    @safe()
    async getIndex() {
        let className: string | undefined = this.constructor?.name;
        className = className === "Object"?undefined:className;
        const title = className?`Index of class ${className}`:`Index of {}`

        const example = 'import {safe} from "restfuncs-server"; // dont forget that import\n\n' +
            (className?`class ${className} {`:'    //...inside your Service class: ') +' \n\n' +
            '    @safe()\n' +
            '    getIndex() {\n\n' +
            '        //... must perform non-state-changing operations only !\n\n' +
            '        this.resp?.contentType("text/html; charset=utf-8");\n' +
            '        return "<!DOCTYPE html><html><body>I\'m aliiife !</body></html>"\n' +
            '    }\n\n' +
            '    // ...'


        this.resp?.contentType("text/html; charset=utf-8");
        return "<!DOCTYPE html>" +
            "<html>" +
            `    <head><title>${escapeHtml(title)}</title></head>` +
            `    <body><h1>${escapeHtml(title)}</h1>` +
            `    This service serves several API methods. You can also fill this index page with life (for simple purposes) by overwriting the getIndex method.<h3>Example</h3><pre>${escapeHtml(example)}</pre>` +
            `    <br/><i>Powered by <a href="https://www.npmjs.com/package/restfuncs">Restfuncs</a></i>` +
            "</body></html>"
    }

    /**
     * Returns a token which you show in later requests, to prove that your browser allowed requests to this service according to the CORS standard. It made a preflight (if needed) and successfully checked the CORS response headers. The request came from an {@link RestfuncsOptions.allowedOrigins}
     * The created read token is stored in the session (so it can be matched with later requests)
     *
     * <p>
     * <i>Technically, the returned token value may be a derivative of what's stored in the session, for security reasons. Implementation may change in the future. Important for you is only that it is comparable / validatable.</i>
     * </p>
     */
    //@safe() // <- don't use safe / don't allow with GET. Maybe an attacker could make an <iframe src="myService/readToken" /> which then displays the result json and trick the user into thinking this is a CAPTCHA
    // TODO: make httponly
    async getCorsReadToken(): Promise<string> {
        const session = this.req.session;
        if(!session) {
            throw new RestError(`No session handler installed. Please see https://github.com/bogeeee/restfuncs#store-values-in-the-http--browser-session`)
        }

        return this.getOrCreateSecurityToken(<SecurityRelevantSessionFields>session, "corsReadToken");
    }

    /**
     * Returns the token for this service which is stored in the session. Creates it if it does not yet exist.
     * @param session req.session (from inside express handler) or this.req.session (from inside a Service call).
     * It must be the RAW session object (and not the proxy that protects it from csrf)
     * <p>
     * <i>Technically, the returned token value may be a derivative of what's stored in the session, for security reasons. Implementation may change in the future. Important for you is only that it is comparable / validatable.</i>
     * </p>
     */
    getCsrfToken(session: object): string {
        // Check for valid input
        if(!session) {
            throw new Error(`session not set. Do you have no session handler installed like [here](https://github.com/bogeeee/restfuncs#store-values-in-the-http--browser-session)`)
        }
        if(typeof session !== "object") {
            throw new Error(`Invalid session value`)
        }
        // Better error message:
        // @ts-ignore
        if(session["__isCsrfProtectedSessionProxy"]) {
            throw new Error("Invalid session argument. Please supply the the raw session object to getCsrfToken(). I.e. use 'this.req.session' instead of 'this.session'")
        }

        return this.getOrCreateSecurityToken(session, "csrfToken");
    }


    /**
     * Get's the complete session, encrypted, so it can be transferred to the websocket connection
     */
    // TODO: make httponly
    async getSession(encryptedSessionRequest: Server2ServerEncryptedBox<SessionTransferRequest>) {
        if(!this.server) {
            throw new Error("Cannot encrypt: No RestfuncsServer instance has been created yet / server not set.")
        }

        const sessionRequestToken = this.server.decryptToken(encryptedSessionRequest, "SessionRequestToken")
        // Security check:
        if(sessionRequestToken.serviceId !== this.id) {
            throw new RestError(`SessionRequestToken from another service`)
        }

        // TODO: test theoretical session access, checkIfRequestIsAllowedToRunCredentialed would throw an error

        const token: SessionTransferToken = {
            request: sessionRequestToken,
            session: this.session || null
        }
        return this.server.encryptToken(token, "SessionTransferToken")
    }

    /**
     * Called via http if the webservice connection has written to the session to update the real session (cookie)
     * @param sessionBox
     */
    // TODO: make httponly
    async updateSession(sessionBox: Server2ServerEncryptedBox<UpdateSessionToken>) {
        if(!this.server) {
            throw new Error("Cannot decrypt: No RestfuncsServer instance has been created yet / server not set.")
        }

        const token = this.server.decryptToken<UpdateSessionToken>(sessionBox, "UpdateSessionToken");
        if(token.serviceId !== this.id) {
            throw new RestError(`updateSession came from another service`)
        }

        // TODO: check if session id matches and version number is exactly 1 higher
    }

    // TODO: make httponly
    async areCallsAllowed(encryptedQuestion: Server2ServerEncryptedBox<AreCallsAllowedQuestion>): Promise<Server2ServerEncryptedBox<AreCallsAllowedAnswer>> {
        if(!this.server) {
            throw new Error("Cannot decrypt: No RestfuncsServer instance has been created yet / server not set.")
        }

        const question = this.server.decryptToken(encryptedQuestion, "CallsAreAllowedQuestion");
        // Security check:
        if(question.serviceId !== this.id) {
            throw new RestError(`Question came from another service`)
        }

        return this.server.encryptToken({
            question,
            value: true
        }, "AreCallsAllowedAnswer");
    }


    /**
     * Generic method for both kinds of tokens (they're created the same way but are stored in different fields for clarity)
     * The token is stored in the session and a transfer token is returned which is BREACH shielded.
     * @param session
     * @param csrfProtectionMode
     * @private
     */
    private getOrCreateSecurityToken(session: SecurityRelevantSessionFields, csrfProtectionMode: "corsReadToken" | "csrfToken"): string {
        if (session.csrfProtectionMode !== undefined && session.csrfProtectionMode !== csrfProtectionMode) {
            throw new RestError(`Session is already initialized with csrfProtectionMode=${session.csrfProtectionMode} but this request wants to use ${csrfProtectionMode}. Please make sure that all browser clients (for this session) use the same mode.`)
        }

        const tokensFieldName = csrfProtectionMode==="corsReadToken"?"corsReadTokens":"csrfTokens";

        // initialize the session:
        session.csrfProtectionMode = csrfProtectionMode;
        const tokens = session[tokensFieldName] = session[tokensFieldName] || {}; // initialize
        checkIfSessionIsValid(session);

        const securityGroupId = this.getSecurityGroupId();
        if (tokens[securityGroupId] === undefined) {
            // TODO: Assume the the session could be sent to the client in cleartext via JWT. Quote: [CSRF tokens should not be transmitted using cookies](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html#synchronizer-token-pattern).)
            // So store a hash(token + server.secret) in the session instead.
            // For a faster validation, the token should have a prefix (64bit randomness to prevent collisions for runtime stability) as a hint which secret was used, so we don't have to try them out all. Similar to Server2ServerEncryptedBox
            // The RestfuncsOptions should may be moved to a field inside this class then (easier API).
            // When having multiple Services, all should use the same key(s), like all session related stuff is global.

            // Create a token:
            tokens[securityGroupId] = crypto.randomBytes(16).toString("hex");
        }

        const token = tokens[securityGroupId];
        const rawToken = Buffer.from(token,"hex");
        return shieldTokenAgainstBREACH(rawToken);
    }

    protected getSecurityGroupId(): string {
        return this.id; // TODO: remove this line when implemented

        if(!this.server) { // Used without RestfuncsExpress server (with classic express) ?
            throw new Error("this.server not set. Please report this as a bug"); // Should we always expect that one server exists ?
        }
        return this.server.getSecurityGroupIdOfService(this)
    }

    /**
     * Wildly collects the parameters. This method is only side effect free but the result may not be secure / contain evil input !
     *
     * For body->Readable parameters and multipart/formdata file -> Readble/UploadFile parameters, this will return before the body/first file is streamed and feed the stream asynchronously
     *
     * @see Service#validateAndDoCall use this method to check the security on the result
     * @param methodName
     * @param req
     */
    protected collectParamsFromRequest(methodName: string, req: Request, enableMultipartFileUploads: boolean) {
        // Determine path tokens:
        const url = URL.parse(req.url);
        const relativePath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
        const pathTokens = relativePath.split("/");

        const reflectedMethod = isTypeInfoAvailable(this)?reflect(this).getMethod(methodName):undefined;

        const result = new class {
            methodArguments: any[] = []; // Params/arguments that will actually enter the method
            metaParams: Record<string, string> = {}
            /**
             * Must be called after the request is finished. Closes up any open streams.
             */
            cleanupStreamsAfterRequest = () => {}
        }

        let listInsertionIndex = -1; // For Listed style /array
        let listInsertionParameter: ReflectedMethodParameter;

        function peekNextListedParameter() {
            if(reflectedMethod) {
                if(listInsertionParameter?.isRest) {
                    return listInsertionParameter;
                }
                if((listInsertionIndex + 1) < reflectedMethod.parameters.length) {
                    return  reflectedMethod.parameters[listInsertionIndex + 1];
                }
            }
        }

        const convertAndAddParams = (params: any, source: ParameterSource) => {

            const addParamsArray = (params: any[]) => {
                function addValue(value: any) {
                    result.methodArguments[listInsertionIndex] = value;
                }

                for(const value of params) {
                    // progress list insertion
                    listInsertionIndex++;
                    if (reflectedMethod) {
                        if (!(listInsertionParameter?.isRest)) { // Not behind rest
                            listInsertionParameter = reflectedMethod.parameters[listInsertionIndex]
                        }
                    }

                    if(!listInsertionParameter) {
                        addValue(value);
                    }
                    else if(listInsertionParameter.isOmitted || listInsertionParameter.isBinding) {
                        addValue(value);
                    }
                    else if(listInsertionParameter.isBinding) {
                        throw new RestError(`Runtime typechecking of destructuring arguments is not yet supported`)
                    }
                    else {
                        addValue(this.autoConvertValueForParameter(value, listInsertionParameter, source));
                    }
                }
            }


            /**
             * Adds the paramsMap to the targetParams array into the appropriate slots and auto converts them.
             */
            const addParamsMap = (paramsMap: Record<string, any>) => {
                for(const name in paramsMap) {
                    if(metaParameterNames.has(name)) {
                        result.metaParams[name] = paramsMap[name];
                        continue
                    }

                    if(!reflectedMethod) {
                        throw new RestError(`Cannot associate the named parameter: ${name} to the method cause runtime type information is not available.\n${this._diagnosisWhyIsRTTINotAvailable()}`)
                    }

                    const parameter: ReflectedMethodParameter|undefined = reflectedMethod.getParameter(name);
                    if(!parameter) {
                        throw new RestError(`Method ${methodName} does not have a parameter named '${name}'`)
                    }
                    if(parameter.isRest) {
                        throw new RestError(`Cannot set ...${name} through named parameter`)
                    }
                    result.methodArguments[parameter.index] = this.autoConvertValueForParameter(paramsMap[name], parameter, source)
                }
            }

            if(params === undefined || params === null) {
                return;
            }

            if(_.isArray(params)) {
                addParamsArray(params);
            }
            else if(typeof params === "object") { // Named ?
                addParamsMap(params);
            }
            else { // Single object ?
                addParamsArray([params])
            }
        }

        // Header (to result.metaParams):
        metaParameterNames.forEach((name) => {
            const headerValue = req.header(name);
            if(headerValue) {
                result.metaParams[name] = String(headerValue); // Ts would not complain but here we explicitly make a string of it just to make sure.
            }
        })

        // Path:
        if(pathTokens.length > 1) { // i.e. the url is  [baseurl]/books/1984
            convertAndAddParams(pathTokens.slice(1),"string");
        }

        // Querystring params:
        if(url.query) {
            const parsed= this.parseQuery(url.query);

            // Diagnosis / error:
            if(!_.isArray(parsed.result)&& (parsed.result["csrfToken"] || parsed.result["corsReadToken"]) && req.method !=="GET") {
                throw new RestError(`You should not send the sensitive csrfToken/corsReadToken in a query parameter (only with GET). Please send it in a header or in the body.`);
            }

            convertAndAddParams(parsed.result, parsed.containsStringValuesOnly?"string":"json");
        }

        // Parse req.body into params:
        if(req.body && req.body instanceof Buffer) {
            const [contentType, contentTypeAttributes] = parseContentTypeHeader(req.header("Content-Type"));
            if (contentType == "application/json") { // Application/json
                const rawBodyText = req.body.toString(fixTextEncoding(contentTypeAttributes["encoding"] || "utf8"));
                convertAndAddParams(JSON.parse(rawBodyText), "json");
            } else if (contentType == "application/brillout-json") {
                const rawBodyText = req.body.toString(fixTextEncoding(contentTypeAttributes["encoding"] || "utf8"));
                convertAndAddParams(brilloutJsonParse(rawBodyText), null);
            } else if(contentType == "application/x-www-form-urlencoded") {
                const rawBodyText = req.body.toString(fixTextEncoding(contentTypeAttributes["encoding"] || "utf8"));
                const parsed= this.parseQuery(rawBodyText);
                convertAndAddParams(parsed.result, parsed.containsStringValuesOnly?"string":"json");
            }
            else if(contentType == "multipart/form-data") {
                if(!enableMultipartFileUploads) {
                    throw new RestError("Please set enableMultipartFileUploads=true in the RestfuncsOptions.")
                }
                let bb = busboy({ headers: req.headers });
            }
            else if(contentType == "application/octet-stream") { // Stream ?
                convertAndAddParams([req.body], null); // Pass it to the Buffer parameter
            }
            else if(peekNextListedParameter()?.type.isClass(Buffer)) { // Next parameter is a Buffer ?
                convertAndAddParams([req.body], null); // Catch the body regardless of further content types
            }
            else if(contentType == "text/plain") {
                const encoding = fixTextEncoding(contentTypeAttributes["encoding"] || "utf8");
                const rawBodyText = req.body.toString(encoding);
                if(rawBodyText === "") {
                    // This means most likely the user didn't want to pass a parameter. The case that the last, not yet defined, param is a string + the api allows to pass an explicit empty string to it and do meaningfull stuff is very rare
                }
                else {
                    try {
                        convertAndAddParams(rawBodyText, null); // no conversion
                        // Do a full check to provoke error for, see catch
                        if (reflectedMethod) {
                            checkParameterTypes(reflectedMethod, result.methodArguments);
                        }
                    } catch (e) {
                        // Give the User a better error hint for the common case that i.e. javascript's 'fetch' automatically set the content type to text/plain but JSON was meant.
                        if (e instanceof Error && diagnosis_looksLikeJSON(rawBodyText)) {
                            throw new RestError(`${e.message}\nHINT: You have set the Content-Type to 'text/plain' but the body rather looks like 'application/json'.`)
                        } else {
                            throw e;
                        }
                    }
                }
            }
            else if(!contentType) { // Unspecified ?
                const rawBodyText = req.body.toString("utf8");
                let valueFromJSON;
                try {
                    valueFromJSON = JSON.parse(rawBodyText);
                }
                catch (e) {
                    valueFromJSON = e;
                }

                if(valueFromJSON !== undefined && !(valueFromJSON instanceof Error)) { // Successfully parsed from json ?
                    convertAndAddParams(valueFromJSON, "json");
                }
                else if(rawBodyText === "") {
                    // This means that most like likely the body is empty and the user didn't want to pass a parameter. The case that the last, not yet defined, param is a string + the api allows to pass an explicit empty string to it and do meaningfull stuff is very rare
                }
                else if(valueFromJSON instanceof Error) {
                    throw valueFromJSON;
                }
                else {
                    throw new RestError("Request body invalid. Consider explicitly specifying the content type")
                }
            }
            else {
                throw new RestError(`Content-Type: '${contentType}' not supported`)
            }
        }
        else if (!_.isEqual(req.body, {})) { // non empty body ?
            throw new RestError("Unhandled non-empty body. Please report this as a bug.")
        }

        return result;
    }

    /**
     * Security checks the method name and args and executes the methods call.
     * @param evil_methodName
     * @param evil_args
     * @param enhancementProps These fields will be temporarily added to this during the call.
     * @param options
     */
    protected async validateAndDoCall(evil_methodName: string, evil_args: any[], enhancementProps: Partial<Service>, options: RestfuncsOptions): Promise<any> {

        // typing was only for the caller. We go back to "any" so must check again:
        const methodName = <any> evil_methodName;
        const args = <any> evil_args;

        // Check methodName:
        if(!methodName) {
            throw new RestError(`methodName not set`)
        }
        if(typeof methodName !== "string") {
            throw new RestError(`methodName is not a string`)
        }
        if( (emptyService[methodName] !== undefined || {}[methodName] !== undefined) && !Service.whitelistedMethodNames.has(methodName)) { // property exists in an empty service ?
            throw new RestError(`You are trying to call a remote method that is a reserved name: ${methodName}`)
        }
        if(this[methodName] === undefined) {
            throw new RestError(`You are trying to call a remote method that does not exist: ${methodName}`)
        }
        const method = this[methodName];
        if(typeof method != "function") {
            throw new RestError(`${methodName} is not a function`)
        }

        // Make sure that args is an array:
        if(!args || args.constructor !== Array) {
            throw new RestError("args is not an array")
        }

        // Runtime type checking of args:
        if(options.checkArguments || (options.checkArguments === undefined && isTypeInfoAvailable(this))) { // Checking required or available ?
            const reflectedMethod = reflect(this).getMethod(methodName); // we could also use reflect(method) but this doesn't give use params for anonymous classes - strangely'
            checkMethodAccessibility(<ReflectedMethod> reflectedMethod);
            checkParameterTypes(<ReflectedMethod> reflectedMethod,args);
        }

        // Check enhancementProps (for the very paranoid):
        if(!enhancementProps || typeof enhancementProps !== "object" || _.functions(enhancementProps).length > 0) {
            throw new Error("Invalid enhancementProps argument");
        }
        const allowed: Record<string, boolean> = {req:true, resp: true, session: true}
        Object.keys(enhancementProps).map(key => {if(!allowed[key]) { throw new Error(`${key} not allowed in enhancementProps`)}})

        let result;
        await enhanceViaProxyDuringCall(this, enhancementProps, async (service) => { // make .req and .resp safely available during call
            result = await service.doCall(methodName, args); // Call method with user's doCall interceptor;
        }, methodName);

        return result
    }

    /**
     * Allows you to intercept calls. Override and implement it with the default body:
     * <pre>
     *      return  await this[funcName](...args) // Call the original function
     * </pre>
     *
     * You have access to this.req, this.resp and this.session as usual.
     *
     * @param funcName name of the function to be called
     * @param args args of the function to be called
     */
    protected async doCall(funcName: string, args: any[]) {
        // @ts-ignore
        return await this[funcName](...args) // Call the original function
    }

    /**
     * Check if the specified request to the specified service's method is allowed to access the session or run using the request's client-cert / basic auth
     *
     * Meaning it passes all the CSRF prevention requirements
     *
     * In the first version, we had the req, metaParams (computation intensive) and options as parameters. But this variant had redundant info and it was not so clear where the enforcedCsrfProtectionMode came from. Therefore we pre-fill the information into reqFields to make it clearer readable.
     * @param reqFields
     * @param enforcedCsrfProtectionMode Must be met by the request (if defined)
     * @param allowedOrigins from the options
     * @param session holds the tokens
     * @param diagnosis
     */
    protected checkIfRequestIsAllowedToRunCredentialed(reqFields: SecurityRelevantRequestFields, enforcedCsrfProtectionMode: CSRFProtectionMode | undefined, allowedOrigins: AllowedOriginsOptions, session: Pick<SecurityRelevantSessionFields,"corsReadTokens" | "csrfTokens">, diagnosis: {acceptedResponseContentTypes: string[], contentType?: string, isSessionAccess: boolean}): void {
        // note that this this called from 2 places: On the beginning of a request with enforcedCsrfProtectionMode like from the RestfuncsOptions. And on session value access where enforcedCsrfProtectionMode is set to the mode that's stored in the session.

        const errorHints: string[] = [];
        /**
         * Indicate this to the client that is should fetch/re-fetch it to solve the problem
         */
        let aValidCorsReadTokenWouldBeHelpful = false;

        /**
         * returns the result as boolean. Collects the above variables.
         */
        const isAllowedInner = () => {

            const diagnosis_seeDocs = "See https://github.com/bogeeee/restfuncs/#csrf-protection."
            const diagnosis_decorateWithsafeExample = `Example:\n\nimport {safe} from "restfuncs-server";\n...\n@safe() // <-- read JSDoc \nfunction ${reqFields.serviceMethodName}(...) {\n    //... must perform non-state-changing operations only\n}`;

            // Fix / default some reqFields for convenience:
            if (reqFields.csrfToken && reqFields.csrfProtectionMode && reqFields.csrfProtectionMode !== "csrfToken") {
                throw new RestError(`Illegal request parameters: csrfProtectionMode:'${reqFields.csrfProtectionMode}' and csrfToken is set.`)
            }
            if (reqFields.corsReadToken && reqFields.csrfProtectionMode && reqFields.csrfProtectionMode !== "corsReadToken") {
                throw new RestError(`Illegal request parameters: csrfProtectionMode:'${reqFields.csrfProtectionMode}' and corsReadToken is set.`)
            }
            if (reqFields.corsReadToken && !reqFields.csrfProtectionMode) {
                throw new RestError(`When sending a corsReadToken, you must also indicate that you want csrfProtectionMode='corsReadToken'. Please indicate that in every request. ${diagnosis_seeDocs}`)
            }
            if (reqFields.csrfToken) {
                reqFields.csrfProtectionMode = "csrfToken"; // Here it's clear from the beginning on, that the user wants this protection mode
            }


            const tokenValid = (tokenType: "corsReadToken" | "csrfToken") => {

                const reqToken = reqFields[tokenType];
                if (!reqToken) {
                    errorHints.push(`Please provide a ${tokenType} in the header / query- / body parameters. ${diagnosis_seeDocs}`);
                    return false;
                }

                const sessionTokens = tokenType == "corsReadToken" ? session.corsReadTokens : session.csrfTokens;
                if (sessionTokens === undefined) {
                    errorHints.push(`Session.${tokenType}s not yet initialized. Maybe the server restarted. Please properly fetch the token. ${diagnosis_seeDocs}`);
                    return false;
                }

                if (!sessionTokens[this.id]) {
                    errorHints.push(`No ${tokenType} was stored in the session for the Service, you are using. Maybe the server restarted or the token, you presented, is for another service. Please fetch the token again. ${diagnosis_seeDocs}`);
                    return false;
                }

                try {
                    if (crypto.timingSafeEqual(Buffer.from(sessionTokens[this.id], "hex"), shieldTokenAgainstBREACH_unwrap(reqToken))) { // sessionTokens[service.id] === reqToken ?
                        return true;
                    } else {
                        errorHints.push(`${tokenType} incorrect`);
                    }
                }
                catch (e) {
                    throw new RestError(`Error validating ${tokenType}: ${(<Error>e)?.message}. Make sure it has the proper form.`, {cause: (e instanceof Error?e:undefined)});
                }

                return false;
            }

            // Check protection mode compatibility:
            if (enforcedCsrfProtectionMode !== undefined) {
                if ((reqFields.csrfProtectionMode || "preflight") !== enforcedCsrfProtectionMode) { // Client and server(/session) want different protection modes  ?
                    errorHints.push(
                        (diagnosis.isSessionAccess ? `The session was created with / is protected with csrfProtectionMode='${enforcedCsrfProtectionMode}'` : `The server requires RestfunscOptions.csrfProtectionMode = '${enforcedCsrfProtectionMode}'`) +
                        (reqFields.csrfProtectionMode ? `, but your request wants '${reqFields.csrfProtectionMode}'. ` : (enforcedCsrfProtectionMode === "csrfToken" ? `. Please provide a csrfToken in the header / query- / body parameters. ` : `, but your request did not specify/want a csrfProtectionMode. `)) +
                        `${diagnosis_seeDocs}`
                    );
                    return false;
                }
            }

            if (enforcedCsrfProtectionMode === "csrfToken") {
                if (reqFields.browserMightHaveSecurityIssuseWithCrossOriginRequests) {
                    // With a non secure browser, we can't trust a valid csrfToken token. Cause these could i.e. read out the contents of the main / index.html page cross-origin by script and extract the token.
                    errorHints.push(`You can't prove a valid csrfToken because your browser does not support CORS or might have security issues with cross-origin requests. Please use a more secure browser. Any modern Browser will do.`)
                    return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
                }
                return tokenValid("csrfToken"); // Strict check already here.
            }
            //Diagnosis:
            if (!reqFields.browserMightHaveSecurityIssuseWithCrossOriginRequests) {errorHints.push(`You could allow the request by showing a csrfToken. ${diagnosis_seeDocs}`)}

            if (originIsAllowed({...reqFields, allowedOrigins}, errorHints)) {
                return true
            }

            // The server side origin check failed but the request could still be legal:
            // In case of same-origin requests: Maybe our originAllowed assumption was false negative (because behind a reverse proxy) and the browser knows better.
            // Or maybe the browser allows non-credentialed requests to go through (which can't do any security harm)
            // Or maybe some browsers don't send an origin header (i.e. to protect privacy)

            if (reqFields.browserMightHaveSecurityIssuseWithCrossOriginRequests) {
                errorHints.push("Your browser does not support CORS or might have security issues with cross-origin requests. Please use a more secure browser. Any modern Browser will do.")
                return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
            }

            if (enforcedCsrfProtectionMode === "corsReadToken") {
                if (tokenValid("corsReadToken")) {  // Read was proven ?
                    return true;
                }
                aValidCorsReadTokenWouldBeHelpful = true;
            }
            else {
                errorHints.push(`You could allow the request by showing a corsReadToken. ${diagnosis_seeDocs}`)
            }

            if (reqFields.couldBeSimpleRequest) { // Simple request (or a false positive non-simple request)
                // Simple requests have not been preflighted by the browser and could be cross-site with credentials (even ignoring same-site cookie)
                if (reqFields.httpMethod === "GET" && this.methodIsSafe(reqFields.serviceMethodName)) {
                    return true // Exception is made for GET to a @safe method. These don't write and the results can't be read (and for the false positives: if the browser thinks that it is not-simple, it will regard the CORS header and prevent reading)
                } else {
                    // Block


                    if (diagnosis.contentType == "application/x-www-form-urlencoded" || diagnosis.contentType == "multipart/form-data") { // SURELY came from html form ?
                    } else if (reqFields.httpMethod === "GET" && reqFields.origin === undefined && _(diagnosis.acceptedResponseContentTypes).contains("text/html")) { // Top level navigation in web browser ?
                        errorHints.push(`GET requests to '${reqFields.serviceMethodName}' from top level navigations (=having no origin)  are not allowed because '${reqFields.serviceMethodName}' is not considered safe.`);
                        errorHints.push(`If you want to allow '${reqFields.serviceMethodName}', make sure it contains only read operations and decorate it with @safe(). ${diagnosis_decorateWithsafeExample}`)
                        if (diagnosis_methodWasDeclaredSafeAtAnyLevel(this.constructor, reqFields.serviceMethodName)) {
                            errorHints.push(`NOTE: '${reqFields.serviceMethodName}' was only decorated with @safe() in a parent class, but it is missing on your *overwritten* method.`)
                        }
                    } else if (reqFields.httpMethod === "GET" && reqFields.origin === undefined) { // Crafted http request (maybe from in web browser)?
                        errorHints.push(`Also when this is from a crafted http request (written by you), you may set the 'IsComplex' header to 'true' and this error will go away.`);
                    } else if (diagnosis.contentType == "text/plain") { // MAYBE from html form
                        errorHints.push(`Also when this is from a crafted http request (and not a form), you may set the 'IsComplex' header to 'true' and this error will go away.`);
                    } else if (reqFields.httpMethod !== "GET" && reqFields.origin === undefined) { // Likely a non web browser http request (or very unlikely that a web browser will send these as simple request without origin)
                        errorHints.push(`You have to specify a Content-Type header.`);
                    }
                    return false; // Block
                }
            } else { // Surely a non-simple request ?
                // *** here we are only secured by the browser's preflight ! ***

                if (reqFields.serviceMethodName === "getCorsReadToken") {
                    return true;
                }

                if (enforcedCsrfProtectionMode === undefined || enforcedCsrfProtectionMode === "preflight") {
                    return true; // Trust the browser that it would bail after a negative preflight
                }
            }

            return false;
        }

        if(!isAllowedInner()) {
            throw new RestError(`${diagnosis.isSessionAccess?`Session access is not allowed`:`Not allowed`}: ` + (errorHints.length > 1?`Please fix one of the following issues: ${errorHints.map(hint => `\n- ${hint}`)}`:`${errorHints[0] || ""}`), {httpStatusCode: aValidCorsReadTokenWouldBeHelpful?480:403})
        }
    }


    /**
     * Wraps the session in a proxy that that checks {@link checkIfRequestIsAllowedToRunCredentialed} on every access
     * @param session
     * @param reqFields
     * @param allowedOrigins
     * @param diagnosis
     */
    protected createCsrfProtectedSessionProxy(session: Record<string, any> & SecurityRelevantSessionFields, reqFields: SecurityRelevantRequestFields, allowedOrigins: AllowedOriginsOptions, diagnosis: {acceptedResponseContentTypes: string[], contentType?: string}) {

        const checkAccess = (isRead: boolean) => {
            if(isRead && session.csrfProtectionMode === undefined) {
                //Can we allow this ? No, it would be a security risk if the attacker creates such a session and makes himself a login and then the valid client with with an explicit csrfProtectionMode never gets an error and actions performs with that foreign account.
            }

            this.checkIfRequestIsAllowedToRunCredentialed(reqFields, session.csrfProtectionMode, allowedOrigins, session, {... diagnosis, isSessionAccess: true})
        }

        return new Proxy(session, {
            get(target: Record<string, any>, p: string | symbol, receiver: any): any {
                // Reject symbols (don't know what it means but we only want strings as property names):
                if (typeof p != "string") {
                    throw new RestError(`Unhandled : ${String(p)}`)
                }

                if(p === "__isCsrfProtectedSessionProxy") { // Probe field ?
                    return true;
                }

                checkAccess(true); // If you first wonder, why need we a read proof for read access: This read may get the userId and call makes WRITES to the DB with it afterwards.

                return target[p];
            },
            set(target: Record<string, any>, p: string | symbol, newValue: any, receiver: any): boolean {
                // Reject symbols (don't know what it means but we only want strings as property names):
                if (typeof p != "string") {
                    throw new RestError(`Unhandled : ${String(p)}`)
                }

                checkAccess(false);

                if(session.csrfProtectionMode === undefined && reqFields.csrfProtectionMode) { // Session protection not yet initialized ?
                    // initialize how the client wants it:
                    const newFields: SecurityRelevantSessionFields = {
                        csrfProtectionMode: reqFields.csrfProtectionMode || "preflight",
                        corsReadTokens: (reqFields.csrfProtectionMode === "corsReadToken")?{}:undefined,
                        csrfTokens: (reqFields.csrfProtectionMode === "csrfToken")?{}:undefined
                    }
                    checkIfSessionIsValid(newFields);
                    _(session).extend(newFields)

                    checkAccess(false); // Check access again. It might likely be the case that we don't have the corsRead token yet. So we don't let the following write pass. It's no security issue but it would be confusing behaviour, if the service method failed in the middle of 2 session accesses. Breaks the testcase acutally. See restfuncs.test.ts -> Sessions#note1
                }

                target[p] = newValue;

                return true;
            },
            deleteProperty(target: Record<string, any>, p: string | symbol): boolean {
                checkAccess(false);
                throw new Error("deleteProperty not implemented.");
            },
            has(target: Record<string, any>, p: string | symbol): boolean {
                checkAccess(true);
                throw new Error("has (property) not implemented.");
            },
            ownKeys(target: Record<string, any>): ArrayLike<string | symbol> {
                checkAccess(true);
                throw new Error("ownKeys not implemented.");
            }

        });

    }



    /**
     * You can override this as part of the API
     * @param query i.e. book=1984&author=George%20Orwell&keyWithoutValue
     * @return I.e. {
     *      result: {book: "1984", author="George Orwell", keyWithoutValue:"true"}
     *      containsStringValuesOnly: true // decides, which of the autoConvertValueForParameter_... methods is used.
     * }
     */
    parseQuery(query: string): {result: Record<string, any>|any [], containsStringValuesOnly: boolean} {
        // Query is a list i.e: "a,b,c" ?
        if(query.indexOf(",") > query.indexOf("=")) { // , before = means, we assume it is a comma separated list
            return {
                result: query.split(",").map( value => decodeURIComponent(value)),
                containsStringValuesOnly: true
            };
        }
        else if(query.indexOf("=") > 0 || query.indexOf("&") > -1){ // Query is a map (named) ?
            const result: Record<string, string> = {};
            const tokens = query.split("&");
            for (const token of tokens) {
                if (!token) {
                    continue;
                }
                if (token.indexOf("=") > -1) {
                    const [key, value] = token.split("=");
                    if (key) {
                        result[decodeURIComponent(key)] = decodeURIComponent(value);
                    }
                } else {
                    result[decodeURIComponent(token)] = "true";
                }
            }
            return {result, containsStringValuesOnly: true};
        }
        else {
            return {result: [decodeURIComponent(query)], containsStringValuesOnly: true}; // Single element
        }
    }

    /**
     * You can override this as part of the API
     * @param methodName method/function name
     * @see RestfuncsOptions.allowGettersFromAllOrigins
     * @return Whether the method is [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), i.e., performs *read-only* operations only !
     */
    public methodIsSafe(methodName: string) {

        if(this[methodName] === Service.prototype[methodName]) { // Method was unmodifiedly taken from the Service mixin. I.e. "getIndex". See Service.initializeService(). ?
            return methodIsMarkedSafeAtActualImplementationLevel(Service, methodName); // Look at Service level
        }

        if(!this.constructor) { // No class ?
            return false; // Non-classes can't have @decorators.
        }

        return methodIsMarkedSafeAtActualImplementationLevel(this.constructor, methodName);
    }

    /**
     * You can override this as part of the API
     * @param methodName
     */
    public hasMethod(methodName: string) {
        return this[methodName] && (typeof this[methodName] === "function");
    }

    /**
     * Retrieves, which method should be picked. I.e GET user -> getUser
     *
     * You can override this as part of the API
     * @param httpMethod
     * @param path the path portion that should represents the method name. No "/"s contained. I.e. "user" (meaning getUser or user)
     */
    public getMethodNameForCall(httpMethod: RegularHttpMethod, path: string): string | null {
        if(path === "") {
            path = "index";
        }

        if (this.hasMethod(path)) { // Direct hit
            return path; // We are done and don't lose performance on other checks
        }

        // check: GET user -> getUser
        {
            const candidate = `${httpMethod.toLowerCase()}${Camelize(path)}`;
            if (this.hasMethod(candidate)) {
                return candidate;
            }
        }


        if (httpMethod === "PUT") {
            // check: PUT user -> updateUser
            {
                const candidate = `update${Camelize(path)}`;
                if (this.hasMethod(candidate)) {
                    return candidate;
                }
            }

            // check: PUT user -> setUser
            {
                const candidate = `set${Camelize(path)}`;
                if (this.hasMethod(candidate)) {
                    return candidate;
                }
            }
        }

        return null;
    }

    /**
     * @see #autoConvertValueForParameter_fromString
     * @see #autoConvertValueForParameter_fromJson
     */
    public autoConvertValueForParameter(value: any, parameter: ReflectedMethodParameter, source: ParameterSource): any {
        if(source === "string") {
            if(typeof value !== "string") {
                throw new Error(`${parameter.name} parameter should be a string`)
            }
            return this.autoConvertValueForParameter_fromString(value, parameter);
        }
        else if(source === "json") {
            return this.autoConvertValueForParameter_fromJson(value, parameter);
        }
        else {
            // TODO: Auto convert Buffers into strings
            return value;
        }
    }

    protected static STRING_TO_BOOL_MAP: Record<string, boolean | undefined> = {
        "true": true,
        "false": false,
        // "1": true, "0": false // Nah -> we should keep the door open for number|bool auto conversion
        "": undefined
    }

    /**
     * Values from the url path or the query are plain strings only.
     * This method is called to convert them to the actual needed parameter type.
     * If it doesn't know how to convert it, the value is returned as is. The validity/security is checked at a later stage again.
     *
     * You can override this as part of the API
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    public autoConvertValueForParameter_fromString(value: string, parameter: ReflectedMethodParameter): any {
        // TODO: number|bool and other ambiguous types could be auto converted to
        try {
            if (parameter.type.isClass(Number)) {
                if (value === "") {
                    return undefined;
                }
                if (value === "NaN") {
                    return Number.NaN
                }
                const result = Number(value);
                if(Number.isNaN(result)) { // Invalid values were converted to NaN but we don't want that.
                    return value;
                }
                return result;
            }

            if (parameter.type.isClass(BigInt)) {
                if (value === "") {
                    return undefined;
                }
                return BigInt(value);
            }

            if (parameter.type.isClass(Boolean)) {
                return Service.STRING_TO_BOOL_MAP[value];
            }

            if (parameter.type.isClass(Date)) {
                if (value === "") {
                    return undefined;
                }
                return new Date(value);
            }

            return value;
        }
        catch (e) {
            throw new RestError(`Error converting value ${value} to parameter ${parameter.name}: ${e instanceof Error && e.message}`) // Wrap this in a RestError cause we probably don't need to reveal the stacktrace here / keep the message simple
        }
    }

    /**
     * Fixes values that were passed in the request body (json) to the actual needed parameter type.
     *
     * Currently this is only for Date objects, since json lacks of representing these.
     * Other values (i.e. parameter needs Number but value is a string) will be left untouched, so they will produce the right error message at the later validity/security checking stage.
     *
     * You can override this as part of the API
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    public autoConvertValueForParameter_fromJson(value: any, parameter: ReflectedMethodParameter): any {
        // *** Help us make this method convert to nested dates like myFunc(i: {someDate: Date})
        // *** You can use [this nice little playground](https://typescript-rtti.org) to quickly see how the ReflectedMethodParameter works ;)
        try {
            // null -> undefined
            if (value === null && !parameter.type.matchesValue(null) && (parameter.isOptional || parameter.type.matchesValue(undefined))) { // undefined values were passed as null (i.e. an parameter array [undefined] would JSON.stringify to [null] TODO: whe should only check this if we came from an array to lessen magic / improve security
                return undefined;
            }

            if (parameter.type.isClass(BigInt) && typeof value === "number") {
                return BigInt(value);
            }

            if (parameter.type.isClass(Date) && typeof value === "string") {
                return new Date(value);
            }

            return value;
        }
        catch (e) {
            throw new RestError(`Error converting value ${diagnisis_shortenValue(value)} to parameter ${parameter.name}: ${e instanceof Error && e.message}`) // Wrap this in a RestError cause we probably don't need to reveal the stacktrace here / keep the message simple
        }
    }

    /**
     * Lists (potentially) callable methods
     * Warning: Not part of the API ! Unlisting a method does not prevent it from beeing called !
     */
    public static listCallableMethods() {

        return reflect(this).methodNames.map(methodName => reflect(this).getMethod(methodName)).filter(reflectedMethod => {
            if (emptyService[reflectedMethod.name] !== undefined || {}[reflectedMethod.name] !== undefined) { // property exists in an empty service ?
                return false;
            }

            try {
                checkMethodAccessibility(<ReflectedMethod>reflectedMethod);
                return true;
            }
            catch (e) {
            }
            return false;
        })
    }

    public static mayNeedFileUploadSupport() {
        // Check if this service has methods that accept buffer

        const someBuffer = new Buffer(0);
        return _.find(this.listCallableMethods(), reflectMethod => {
            return _.find(reflectMethod.parameters, param => {
                if(param.type.isAny()) {
                    return false;
                }

                return param.type.matchesValue(someBuffer) ||
                    (param.isRest && param.type.matchesValue([someBuffer]))
            }) !== undefined;
        }) !== undefined;
    }

    public static _diagnosisWhyIsRTTINotAvailable() {
        return "TODO"
    }


    /**
     *
     * @param error
     * @param req For retrieving info for logging
     */
    protected logAndConcealError(error: Error, req: Request) {
        /**
         * Removes usual error properties (leaving all custom properties)
         */
        function customPropertiesOnly(e: ErrorWithExtendedInfo) {
            const result = cloneError(e);
            ERROR_PROPERTIES.forEach((propName) => {
                // @ts-ignore
                delete result[propName];
            });
            return result;
        }


        const errorExt: ErrorWithExtendedInfo = cloneError(error);

        // Log error:
        let errorId;
        // @ts-ignore
        const error_log: boolean | undefined = error.log // Better type
        if(error_log !== false && (error_log || this.options.logErrors !== false)) {
            if(this.options.exposeErrors !== true) { // We need an errorId cause we'll conceal some info ?
                errorId = crypto.randomBytes(6).toString("hex");
            }

            const logMessage = `${errorId?`[${errorId}]: `:""}${errorToString(errorExt)}`;
            if(typeof this.options.logErrors === "function") {
                this.options.logErrors(logMessage, req)
            }
            else {
                console.error(logMessage);
            }
        }

        // ** Cut off the parts of errorExt that should not be exposed and add some description *** :

        const DIAGNOSIS_SHOWFULLERRORS="If you want to see full errors on the client (development), set exposeErrors=true in the ServiceOptions."
        if(this.options.exposeErrors === true) {
            return errorExt;
        }

        let definitelyIncludedProps: Record<string, any> = {};
        if(isRestError(error) && error.constructor !== RestError) { // A (special) SUB-class of RestError ? I.e. think of a custom NotLoggedInError
            // Make sure this error is ALWAYS identifyable by the client and its custom properties are included, cause they were explicitly implemented by the user for a reason.
            definitelyIncludedProps = {
                ...customPropertiesOnly(errorExt),
                message: errorExt.message,
                name: errorExt.name,
            };
        }

        if(this.options.exposeErrors === "messagesOnly") {
            return {
                message: errorExt.message,
                name: errorExt.name,
                stack: isRestError(error)?undefined:`Stack hidden.${errorId?` See [${errorId}] in the server log.`:""} ${DIAGNOSIS_SHOWFULLERRORS}`,
                ...definitelyIncludedProps,
            };
        }
        else if( (this.options.exposeErrors === "RestErrorsOnly" || this.options.exposeErrors === undefined) && isRestError(error)) {
            return {
                message: errorExt.message,
                name: errorExt.name,
                ...definitelyIncludedProps,
            };
        }
        else {
            return {
                message: `Internal server error.${errorId?` See [${errorId}] in the server log.`:""} ${DIAGNOSIS_SHOWFULLERRORS}`,
                name: "Error",
                ...definitelyIncludedProps,
            }
        }
    }

    /**
     * Eventually logs the error and returns a line that is safe for pasting into a stream, meaning it contains no craftable content.
     * @param error
     */
    protected logAndGetErrorLineForPasteIntoStreams(error: Error, req: Request) {

        // TODO: if(this.options.disableSecurity) { return full message }

        if(this.options.logErrors) {
            fixErrorStack(error)
            const errorExt: ErrorWithExtendedInfo = cloneError(error);

            const errorId = crypto.randomBytes(6).toString("hex");
            const logMessage = `${errorId?`[${errorId}]: `:""}${errorToString(errorExt)}`;

            if(typeof this.options.logErrors === "function") {
                this.options.logErrors(logMessage, req)
            }
            else {
                console.error(logMessage);
            }

            return `Error in stream. See [${errorId}] in the server log.`
        }
        else {
            return `Error in stream. Please enable logErrors in the RestfuncsOptions if you want to see it in the logs.`
        }



    }


    /**
     * Registry to make ensure that IDs are unique
     * @private
     * TODO: move to Server.services
     */
    private static idToService = new Map<string, Service>()

    /**
     * ..., therefore, ids are registered within here.
     * @private
     */
    private checkIfIdIsUnique() {
        if(!this.id) {
            throw new Error("id not set. Please specify an id property on your service.")
        }

        const registered = Service.idToService.get(this.id);
        if(registered === this) {
            return;
        }

        if(registered !== undefined ) { // Duplicate ?
            if(this.constructor?.name === this.id) {
                throw new Error(`A \`class ${this.id}\` is used twice as a service. Please set the 'id' property in your instances to make them unique.`)
            }

            throw new Error(`Current (generated) id is not unique: '${this.id}'`)
        }

        Service.idToService.set(this.id, this);
    }

    /**
     * Access static members from an instance.
     * <p>
     * In order to make your special static subclass's members available, override it and change the signature accordingly.
     * </p>
     */
    getClass(): typeof Service {
        // @ts-ignore
        return this.constructor
    }

    /**
     * Returns an id for this Service.
     *
     * It's not checked for uniqueness.
     * @see checkIfIdIsUnique
     * @private
     */
    public static generatedId(service: object): string {
        const className = service.constructor?.name
        if(className && className !== "Object") {
            return className;
        }

        // TODO: create a hash instead, that's better and shorter (imagine JWT sessions with limited size)
        // generate an id of the first function names that are found.
        const MAX_LENGTH = 40;
        let result = "Obj";
        for(const k of Object.getOwnPropertyNames(service)) {
            // @ts-ignore
            if(typeof k === "string" && typeof service[k] == "function") {
                result+="_" + k;
                if(result.length >= MAX_LENGTH) {
                    return result.substring(0, MAX_LENGTH);
                }
            }
        }

        // not enough info found ? I.e. the object was enhanced during typescript-rtti compile
        const prototype = Object.getPrototypeOf(service);
        if(prototype) {
            return this.generatedId(prototype); // Take the prototype
        }

        return result;
    }
}

/**
 *
 * Flag your function with this decorator as [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), if you are sure it essentially performs only *read* operations.
 *
 * This flag is needed to allow for some cases where cross site security can't be checked otherwise. i.e:
 *   - A function that serves a html page so it should be accessible by top level navigation (i.e from a bookmark or an email link) as these don't send an origin header.
 *   - functions that serve an image publicly to all origins.
 *
 *
 * @example
 * <pre>
 * import {safe} from "restfuncs-server";
 *
 *     //...inside your service class/object:
 *
 *     @safe()
 *     getUserStatusPage() {
 *
 *         // ... SECURITY: code in @safe() methods must perform read operations only !
 *
 *         this.resp?.contentType("text/html; charset=utf-8");
 *         return `<html>
 *             isLoggedOn: ${isLoggedOn},
 *             yourLibraryKey: ${escapeHtml(xy)} // You can still send sensitive information because a browser script from a non allowed origins can't extract the contents of simple/non-preflighted GET requests
 *         </html>`;
 *     }
 * </pre>
 */
export function safe() {
    return function (target: any, methodName: string, descriptor: PropertyDescriptor) {
        const constructor = target.constructor;
        if(!Object.getOwnPropertyDescriptor(constructor,"safeMethods")?.value) { // constructor does not have it's OWN .safeMethods initialized yet ?
            constructor.safeMethods = new Set<string>();
        }

        constructor.safeMethods.add(methodName);
    };
}

/**
 * Meaning, if an overwritten method does not also explicitly have @safe, it's not considered safe
 * @param classConstructor
 * @param methodName
 * @return true if the method was decorated @safe at this
 */
function methodIsMarkedSafeAtActualImplementationLevel(classConstructor: Function, methodName: string): boolean {
    if(!classConstructor.prototype) { // Don't know / unhandled
        return false;
    }

    if(classConstructor.prototype.hasOwnProperty(methodName)) { // Method defined at this level ?
        // Check that is was decorated @safe at this level:
        // @ts-ignore
        const safeMethods = <Set<string>> classConstructor?.safeMethods;

        return safeMethods !== undefined && safeMethods.has(methodName);
    }

    // Check at parent level
    const baseConstructor = Object.getPrototypeOf(classConstructor);
    if(baseConstructor) {
        return methodIsMarkedSafeAtActualImplementationLevel(baseConstructor, methodName);
    }

    return false;
}

/**
 * To hin with error messages
 * @param constructor
 * @param methodName
 */
export function diagnosis_methodWasDeclaredSafeAtAnyLevel(constructor: Function | undefined, methodName: string): boolean {
    if(!constructor) {
        return false;
    }

    // @ts-ignore
    const safeMethods = <Set<string>> constructor?.safeMethods;

    if(safeMethods !== undefined && safeMethods.has(methodName)) {
        return true;
    }

    // Check at parent level
    const baseConstructor = Object.getPrototypeOf(constructor);
    if(baseConstructor) {
        return diagnosis_methodWasDeclaredSafeAtAnyLevel(baseConstructor, methodName);
    }

    return false;
}

// *** Tokens that are transfered between the websocket connection and the http service *** See Security concept.md

/**
 * Question from the websocket connection
 */
type AreCallsAllowedQuestion = {
    /**
     * Must be a random id
     */
    websocketConnectionId: string
    serviceId: string,
}

type AreCallsAllowedAnswer = {
    question: AreCallsAllowedQuestion
    value: boolean
}



/**
 * The websocket connections sees at some point that it need a valid session
 */
type SessionTransferRequest = {
    /**
     * Random id to make sure that we can't give it a session from the past or an evil client
     */
    id: string
    serviceId: string,
}

export type SessionTransferToken = {
    /**
     * re-include that token
     */
    request: SessionTransferRequest

    session: object | null
}

export type UpdateSessionToken = {
    /**
     * Where did this come from ?
     */
    serviceId: string,

    sessionId: string | null

    /**
     * Current / old version
     */
    currentVersion: number

    newSession: object | null
}

/**
 *
 * @param params: pre-computed origin and destination
 * @param errorHints Error messages will be added here
 * @return if origin and destination are allowed by the "allowedOrigins" option
 */
function originIsAllowed(params: { origin?: string, destination?: string, allowedOrigins: AllowedOriginsOptions }, errorHints?: string[]): boolean {
    function isSameOrigin() {
        return params.destination !== undefined && params.origin !== undefined && (params.origin === params.destination);
    }

    if (params.allowedOrigins === "all") {
        return true;
    }


    if (typeof params.allowedOrigins === "function") {
        if (params.allowedOrigins(params.origin, params.destination)) {
            return true;
        }
    }

    if (!params.origin) {
        // Return with a better errorHint:
        errorHints?.push("No origin/referrer header present. May be your browser is just hiding it.")
        return false;
    }

    if (typeof params.allowedOrigins === "function") {
        // prevent the default else
    } else if (!params.allowedOrigins) { // Only same origin allowed ?
        if (isSameOrigin()) {
            return true
        }
    } else if (_.isArray(params.allowedOrigins)) {
        if (isSameOrigin() || (params.origin !== undefined && _(params.allowedOrigins).contains(params.origin))) {
            return true;
        }
    } else {
        throw new Error("Invalid value for allowedOrigins: " + params.allowedOrigins)
    }


    if (false) { // TODO x-forwarded-by header == getDestination(req)
        // errorHints.push(`it seems like your server is behind a reverse proxy and therefore the server side same-origin check failed. If this is the case, you might want to add ${x-forwarded-by header} to RestfuncsOptions.allowedOrigins`)
    }

    errorHints?.push(`Request is not allowed from ${params.origin || "<unknown / no headers present>"} to ${params.destination}. See the allowedOrigins setting in the RestfuncsOptions. Also if you app server is behind a reverse proxy and you think the resolved proto/host/port of '${params.destination}' is incorrect, add the correct one (=what the user sees in the address bar) to allowedOrigins.`)

    return false;
}

export type SecurityRelevantRequestFields = {
    httpMethod: string,
    /**
     * The / your Service's method name that's about to be called
     */
    serviceMethodName: string,
    /**
     * Computed origin
     * @see getOrigin
     */
    origin?: string,
    /**
     * Computed destination
     * @see getDestination
     */
    destination?: string,

    /**
     * Computed result from Util.js/browserMightHaveSecurityIssuseWithCrossOriginRequests function
     */
    browserMightHaveSecurityIssuseWithCrossOriginRequests: Boolean;

    csrfProtectionMode?: CSRFProtectionMode
    corsReadToken?: string,
    csrfToken?: string,
    /**
     * Computed result from couldBeSimpleRequest function
     */
    couldBeSimpleRequest?: boolean
};

/**
 * Checks that session is in a valid state (security relevant fields)
 *
 * Will be called on each write to security relevant fields
 * @param session
 */
function checkIfSessionIsValid(session: SecurityRelevantSessionFields) {
    if(session.csrfProtectionMode === "corsReadToken") {
        if(!session.corsReadTokens || session.csrfTokens) {
            throw new Error("Illegal state");
        }

    }
    else if(session.csrfProtectionMode === "csrfToken") {
        if(session.corsReadTokens || !session.csrfTokens) {
            throw new Error("Illegal state");
        }
    }
    else if(session.csrfProtectionMode === "preflight" || session.csrfProtectionMode === undefined) {
        if(session.corsReadTokens || session.csrfTokens) {
            throw new Error("Illegal state");
        }
    }

    else {
        throw new Error(`Illegal value for csrfProtectionMode: '${session.csrfProtectionMode}'`);
    }
}

/**
 * Needed for security checks.
 */
class EmptyService extends Service {
}
const emptyService = new EmptyService({checkArguments: false});