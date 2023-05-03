import 'reflect-metadata' // Must import
import express, {raw, Router, Request} from "express";
import session from "express-session";
import {
    cloneError,
    diagnisis_shortenValue,
    ERROR_PROPERTIES,
    errorToHtml,
    errorToString,
    ErrorWithExtendedInfo,
    fixErrorStack
} from "./Util";
import http from "node:http";
import crypto from "node:crypto";
import {Writable, Readable, Transform, PassThrough} from "node:stream"
import {reflect, ReflectedMethod, ReflectedMethodParameter} from "typescript-rtti";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify"
import {
    checkParameterTypes,
    diagnosis_methodWasDeclaredSafeAtAnyLevel,
    isTypeInfoAvailable,
    ParameterSource,
    RestService
} from "./RestService";
import _ from "underscore";
import URL from "url"
import busboy from "busboy";

export {RestService, safe} from "./RestService";

const PROTOCOL_VERSION = "1.1" // ProtocolVersion.FeatureVersion

export type RestfuncsOptions = {
    /**
     * Only for standalone server
     */
    path?: string

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
    exposeErrors?: true|"messagesOnly"|"RestErrorsOnly"|false

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
    allowedOrigins?: "all" | string[] | ( (origin?: string, destination?: string) => boolean )


    //allowTopLevelNavigationGET?: boolean // DON'T allow: We can't see know if this really came from a top level navigation ! It can be easily faked by referrerpolicy="no-referrer"

    //sessionCSRFProtection <- not here, at each session


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
     * - implement the access token logic yourself, see {@link RestService.proofRead()}
     * - disable this feature and trust on browsers to make preflights and bail if they fail.
     *
     * Note: For client developers with tokenized modes: You may wonder wonder why some requests will still pass without token checks. They may be already considered safe according the the origin/referrer headers or for @safe methods.
     * If you want this stricter while developing your clients and raise early errors, enable the {@link devForceSessionCSRFProtection} and {@link devForceTokenCheck} developlment options.
     *
     * Default: true
     */
    csrfProtection?: CSRFProtectionMode

    /**
     * For "readToken" mode only:
     * <p>Many requests are usually allowed to go through without requiring the read token. I.e if host/origin/referer headers are present or if no session is accessed at all.
     *     </p>
     * <p>
     * Here you can force the check for every request (except {@link safe() safe methods}), so you'll <strong>see early in the development if the token was not properly passed</strong>.
     * </p>
     */
    devForceTokenCheck?: boolean




    /**
     * Enable/disable file uploads through http multipart
     * If not needed, you may disable this to have one less http parser library (busboy) involved (security).
     *
     * undefined (default) = auto detect if really needed by scanning for functions that have Buffer parameters
     */
    enableMultipartFileUploads?: boolean
}

/**
 * Makes service's member functions callable via REST in a standalone http server.
 *
 * Side effects: The service.req/resp/session fields will be set to null
 * @param service
 * @param port
 * @param options
 * @return
 */
export function restfuncs(service: object | RestService, port: number, options?: RestfuncsOptions) : http.Server;
/**
 * Creates an express router/middleware that makes service's member functions callable via REST.
 * Usage:
 *     app.use("/myAPI", restfuncs( myService, { ...options});
 *
 * Side effects: The service.req/resp/session fields will be set to null
 * @param service
 * @return
 */
export function restfuncs(service: object | RestService, options?: RestfuncsOptions): Router;
export function restfuncs(service: object | RestService, arg1: any, arg2?: any): any {

    if(typeof(arg1) == "number") { // standalone ?
        const port = arg1;
        const options:RestfuncsOptions = arg2 || {};

        if(typeof (options) !== "object") {
            throw new Error("Invalid argument")
        }

        const app = express();

        // Install session handler:
        app.use(session({
            secret: crypto.randomBytes(32).toString("hex"),
            cookie: {sameSite: true},
            saveUninitialized: false,
            unset: "destroy",
            store: undefined, // Default to MemoryStore, but use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
        }));

        app.use(createRestFuncsExpressRouter(service, options));
        return app.listen(port);
    }
    else { // Express router
        const options:RestfuncsOptions = arg1 || {};

        if(typeof (options) !== "object") {
            throw new Error("Invalid argument")
        }

        return createRestFuncsExpressRouter(service, options);
    }
}

export default restfuncs

type CSRFProtectionMode = "preflight" | "corsReadToken" | "csrfToken"


type SessionProtectionHeader = {
    /**
     *
     */
    _protection?: CSRFProtectionMode

    /**
     * When corsWithReadProof, this read proof must be shown for each session access
     *
     * RestService base url -> token
     */
    _readTokens?: Record<string,string>

    /**
     * One for each service
     *
     * RestService base url -> token
     */
    _csrfTokens?: Record<string,string>
};

/**
 * Checks that session is in a valid state
 * @param session
 */
function checkSessionProtectionIsValid(session: Record<string, any>) {
    if(session._protection === "corsReadToken") {
        if(!session._readTokens || session._csrfTokens) {
            throw new Error("Illegal state");
        }

    }
    else if(session._protection === "csrfToken") {
        if(session._readTokens || !session._csrfTokens) {
            throw new Error("Illegal state");
        }
    }
    else if(session._protection === "preflight" || session._protection === undefined) {
        if(session._readTokens || session._csrfTokens) {
            throw new Error("Illegal state");
        }
    }
    else {
        throw new Error("Illegal state");
    }
}

function createCsrfProtectedSessionProxy(session: Record<string, any> & SessionProtectionHeader, req: Request, isForSafeMethod = false) {


    function requestIsFromRestfuncsClient() {
        return req.header("restfuncs-client-version") !== undefined
    }

    /**
     * Checks if reads+write are allowed and throws an error
     * For writes, the prooftype must be specified before you call this
     */
    function checkAccess(isRead: boolean) {
        checkSessionProtectionIsValid(session)

        if(isRead && isForSafeMethod) {
            return; // Allow cause they don't change the state
        }

        if(session._protection === undefined) {
            if(isRead) {
                return; // allow reads. Session is still empty
            }
            throw new Error("_proofType should be initialized first")
        }
        else if(session._protection === "preflight") {
            if(requestIsFromRestfuncsClient()) {
                throw new RestError("The session was already written to by a non-Restfuncs client (which did not prove that it can make CORS reads). You can't access it via Restfuncs client then.")
            }
            return
        }
        else if(session._protection === "corsReadToken") { // TODO: Assume the the session could be sent to the client in cleartext via JWT, so derive the token
            const corsReadProofFromRequest = req.header("corsReadProofFromRequest");
            if(!corsReadProofFromRequest) {
                throw new RestError("The session was already written to by a Restfuncs client. To access values of it, you must also proof that you can read the result of HTTP requests by calling proofRead() and send the returned {corsReadProof} token in your next requests (as a header).")
            }

            if(corsReadProofFromRequest !== session._corsReadProofToken) {
                throw new RestError("Wrong corsReadProof. Maybe the session timed out and another session was created in the meanwhile. Please re-fetch that token.")
            }
            return;
        }

        throw new Error("Illegal _proofType value")
    }

    return new Proxy(session, {
        get(target: Record<string, any>, p: string | symbol, receiver: any): any {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new RestError(`Unhandled : ${String(p)}`)
            }


            checkAccess(true); // If you first wonder, why need we a read proof for read access? But this read may get the userId and call makes WRITES to the DB with it afterwards.

            return target[p];
        },
        set(target: Record<string, any>, p: string | symbol, newValue: any, receiver: any): boolean {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new RestError(`Unhandled : ${String(p)}`)
            }

            if(isForSafeMethod) {
                throw new Error("Must not make writes to the session from an @safe() method you naughty coder !!!")
            }

            // if browser allows writes without reads, an attacker could create a new session and login his user

            if(session._protection === undefined) { // New / undecided session ?
                // Specify the proofType:
                if(requestIsFromRestfuncsClient()) {
                    session._protection = "corsReadToken"
                    session._corsReadProofToken = crypto.randomBytes(32).toString("hex")
                }
                else {
                    session._protection = "preflight";
                }

                checkSessionProtectionIsValid(session);
            }

            checkAccess(false);

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
 * Creates a proxy for the session object that sees the values from the prototype and only writes values to req.session on modification.
 * @param session the real / target session object
 * @param sessionPrototype object that contains the initial values
 */
function createProxyWithPrototype(session: Record<string, any>, sessionPrototype: Record<string, any>) {
    return new Proxy(session, {
        get(target: Record<string, any>, p: string | symbol, receiver: any): any {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new RestError(`Unhandled : ${String(p)}`)
            }

            if (target[p] === undefined) {
                return sessionPrototype[p];
            }
            return target[p];
        },
        set(target: Record<string, any>, p: string | symbol, newValue: any, receiver: any): boolean {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new RestError(`Unhandled : ${String(p)}`)
            }

            if (newValue === undefined && sessionPrototype[p] !== undefined) { // Setting a value that exists on the prototype to undefined ?
                throw new RestError(`Cannot set session.${p} to undefined. Please set it to null instead.`) // We can't allow that because the next get would return the initial value (from the prototype) and that's not an expected behaviour.
            }

            target[p] = newValue;

            return true;
        },
        deleteProperty(target: Record<string, any>, p: string | symbol): boolean {
            throw new Error("deleteProperty not implemented.");
        },
        has(target: Record<string, any>, p: string | symbol): boolean {
            throw new Error("has (property) not implemented.");
        },
        ownKeys(target: Record<string, any>): ArrayLike<string | symbol> {
            throw new Error("ownKeys not implemented.");
        }

    });
}


/**
 * Creates a middleware/router to use with express.
 * @param service An object who's methods can be called remotely / are exposed as a rest service.
 */
function createRestFuncsExpressRouter(restServiceObj: object, options: RestfuncsOptions): Router {    ;
    checkOptionsValidity(options)
    const restService = RestService.initializeRestService(restServiceObj, options);

    const enableMultipartFileUploads = options.enableMultipartFileUploads || (options.enableMultipartFileUploads === undefined && (!isTypeInfoAvailable(restService) || restService.mayNeedFileUploadSupport()))

    const router = express.Router();

    router.use(express.raw({limit: Number.MAX_VALUE, inflate: false, type: req => true})) // parse application/brillout-json and make it available in req.body

    router.use(async (req, resp, next) => {
        let acceptedResponseContentTypes = [...(req.header("Accept")?.split(",") || []), "application/json"]; // The client sent us a comma separated list of accepted content types. + we add a default: "application/json" // TODO: add options
        acceptedResponseContentTypes.map(value => value.split(";")[0]) // Remove the ";q=..." (q-factor weighting). We just simply go by order

        /**
         * Http-sends the result, depending on the requested content type:
         */
        function sendResult(result: any, diagnosis_methodName?: string) {
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
                        resp.end(logAndGetErrorLineForPasteIntoStreams(err, options,req));
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
            const originAllowed = originIsAllowed(req, options);
            // Answer preflights:
            if(req.method === "OPTIONS") {
                if(originAllowed) {
                    if(req.header("Access-Control-Request-Method")) { // Request is a  CORS preflight (we don't care which actual method) ?
                        resp.header("Access-Control-Allow-Origin", getOrigin(req))
                        resp.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,DELETE")
                        resp.header("Access-Control-Allow-Headers", "content-type, accept");
                        resp.header("Access-Control-Allow-Credentials", "true")

                        resp.header("Vary", "Origin")
                        //resp.header("Access-Control-Max-Age", "3600") // Stick with the defaults / pros + cons not researched

                        resp.status(204);
                    }
                }
                else {
                    throw new RestError(diagnosis_originNotAllowedMessage(req), {httpStatusCode: 204});
                }

                resp.end();
                return;
            }

            // Add cors header:
            if(originAllowed) {
                // Send CORS headers (like preflight)
                resp.header("Access-Control-Allow-Origin", getOrigin(req));
                resp.header("Access-Control-Allow-Credentials", "true")
            }

            // retrieve method name:
            const fixedPath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
            let methodNameFromPath = fixedPath.split("/")[0];
            const methodName = restService.getMethodNameForCall(req.method, methodNameFromPath);
            if(!methodName) {
                if(!methodNameFromPath) {
                    throw new RestError(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`)
                }
                throw new RestError(`No method candidate found for ${req.method} + ${methodNameFromPath}.`)
            }

            const collectedParams = collectParamsFromRequest(restService, methodName, req, enableMultipartFileUploads);

            const errorHints: string[] = [];
            if(!methodIsAllowedCredentialed(methodName, req, options, restService, errorHints)) {
                throw new RestError(`Not allowed: ` + (errorHints.length > 1?`Please fix one of the following issues: ${errorHints.map(hint => `\n- ${hint}`)}`:`${errorHints[0] || ""}`))
            }

            let session = null;
            // @ts-ignore
            const reqSession = req.session as Record<string,any>|undefined;
            if(reqSession !== undefined) { // Express runs a session handler ?
                session = createProxyWithPrototype(reqSession, restService._sessionPrototype!); // Create the this.session object which is a proxy that writes/reads to req.session but shows service.session's initial values. This way we can comply with the session's saveUninitialized=true / privacy friendliness
            }

            let result = await restService.validateAndDoCall(methodName, collectedParams, {req, resp, session}, options);
            sendResult(result, methodName);
        }
        catch (caught) {
            if(caught instanceof Error) {
                resp.status( isRestError(caught) && (<RestError>caught).httpStatusCode || 500);

                fixErrorStack(caught)
                let error = logAndConcealError(caught, options, req);

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
    });

    return router;
}

/**
 * Wildly collects the parameters. This method is only side effect free but the result may not be secure !
 *
 * @see RestService#validateAndDoCall use this method to check the security on the result
 * @param restService
 * @param methodName
 * @param req
 * @return evil parameters
 */
function collectParamsFromRequest(restService: RestService, methodName: string, req: Request, enableMultipartFileUploads: boolean): any[] {
    // Determine path tokens:
    const url = URL.parse(req.url);
    const relativePath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
    const pathTokens = relativePath.split("/");

    const reflectedMethod = isTypeInfoAvailable(restService)?reflect(restService).getMethod(methodName):undefined;

    let result: any[] = []; // Params that will actually enter the method
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

    const convertAndAddParams = function(params: any, source: ParameterSource) {

        function addParamsArray(params: any[]): void {
            function addValue(value: any) {
                result[listInsertionIndex] = value;
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
                    addValue(restService.autoConvertValueForParameter(value, listInsertionParameter, source));
                }
            }
        }


        /**
         * Adds the paramsMap to the targetParams array into the appropriate slots and auto converts them.
         */
        function addParamsMap(paramsMap: Record<string, any>) {
            if(!reflectedMethod) {
                throw new RestError(`Cannot associate the named parameters: ${Object.keys(paramsMap).join(", ")} to the method cause runtime type information is not available.\n${restService._diagnosisWhyIsRTTINotAvailable()}`)
            }

            for(const name in paramsMap) {
                const parameter: ReflectedMethodParameter|undefined = reflectedMethod.getParameter(name);
                if(!parameter) {
                    throw new RestError(`Method ${methodName} does not have a parameter named '${name}'`)
                }
                if(parameter.isRest) {
                    throw new RestError(`Cannot set ...${name} through named parameter`)
                }
                result[parameter.index] = restService.autoConvertValueForParameter(paramsMap[name], parameter, source)
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


    // Path:
    if(pathTokens.length > 1) { // i.e. the url is  [baseurl]/books/1984
        convertAndAddParams(pathTokens.slice(1),"string");
    }

    // Querystring params:
    if(url.query) {
        const parsed= restService.parseQuery(url.query);
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
            const parsed= restService.parseQuery(rawBodyText);
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
            try {
                convertAndAddParams(rawBodyText, null); // no conversion
                // Do a full check to provoke error for, see catch
                if(reflectedMethod) {
                    checkParameterTypes(reflectedMethod, result);
                }
            }
            catch (e) {
                // Give the User a better error hint for the common case that i.e. javascript's 'fetch' automatically set the content type to text/plain but JSON was meant.
                if(e instanceof Error && diagnosis_looksLikeJSON(rawBodyText)) {
                    throw new RestError(`${e.message}\nHINT: You have set the Content-Type to 'text/plain' but the body rather looks like 'application/json'.`)
                }
                else {
                    throw e;
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
 *
 * @param contentType I.e. text/plain;charset=UTF-8
 * @return Would result into ["text/plain", {charset: "UTF-8"}]
 */
function parseContentTypeHeader(contentType?: string): [string | undefined, Record<string, string>] {
    const attributes: Record<string, string> = {};

    if(!contentType) {
        return [undefined, attributes];
    }
    const tokens = contentType.split(";");
    for (const token of tokens.slice(1)) {
        if (!token || token.trim() == "") {
            continue;
        }
        if (token.indexOf("=") > -1) {
            const [key, value] = token.split("=");
            if (key) {
                attributes[key.trim()] = value?.trim();
            }
        }
    }

    return [tokens[0], attributes]
}

/**
 * Fixes the encoding to a value, compatible with Buffer
 * @param encoding
 */
function fixTextEncoding(encoding: string): BufferEncoding {
    const encodingsMap: Record<string, BufferEncoding> = {
        "us-ascii": 'ascii',
        'ascii': "ascii",
        'utf8': 'utf8',
        'utf-8': 'utf-8',
        'utf16le': 'utf16le',
        'ucs2': 'ucs2',
        'ucs-2': 'ucs2',
        'base64': 'base64',
        'base64url': 'base64url',
        'latin1': 'latin1',
    };
    const result = encodingsMap[encoding.toLowerCase()];

    if(!result) {
        throw new RestError(`Invalid encoding: '${encoding}'. Valid encodings are: ${Object.keys(encodingsMap).join(",")}`)
    }

    return result;
}

/**
 *
 * @param error
 * @param options
 * @param req Retrieve For retrieving info for logging
 */
function logAndConcealError(error: Error, options: RestfuncsOptions, req: Request) {
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
    if(error_log !== false && (error_log || options.logErrors !== false)) {
        if(options.exposeErrors !== true) { // We need an errorId cause we'll conceal some info ?
            errorId = crypto.randomBytes(6).toString("hex");
        }

        const logMessage = `${errorId?`[${errorId}]: `:""}${errorToString(errorExt)}`;
        if(typeof options.logErrors === "function") {
            options.logErrors(logMessage, req)
        }
        else {
            console.error(logMessage);
        }
    }

    // ** Cut off the parts of errorExt that should not be exposed and add some description *** :

    const DIAGNOSIS_SHOWFULLERRORS="If you want to see full errors on the client (development), set exposeErrors=true in the restfuncs options."
    if(options.exposeErrors === true) {
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

    if(options.exposeErrors === "messagesOnly") {
        return {
            message: errorExt.message,
            name: errorExt.name,
            stack: isRestError(error)?undefined:`Stack hidden.${errorId?` See [${errorId}] in the server log.`:""} ${DIAGNOSIS_SHOWFULLERRORS}`,
            ...definitelyIncludedProps,
        };
    }
    else if( (options.exposeErrors === "RestErrorsOnly" || options.exposeErrors === undefined) && isRestError(error)) {
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
 * @param options
 */
function logAndGetErrorLineForPasteIntoStreams(error: Error, options: RestfuncsOptions, req: Request) {

    // TODO: if(options.disableSecurity) { return full message }

    if(options.logErrors) {
        fixErrorStack(error)
        const errorExt: ErrorWithExtendedInfo = cloneError(error);

        const errorId = crypto.randomBytes(6).toString("hex");
        const logMessage = `${errorId?`[${errorId}]: `:""}${errorToString(errorExt)}`;

        if(typeof options.logErrors === "function") {
            options.logErrors(logMessage, req)
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

const FAST_JSON_DETECTOR_REGEXP = /^([0-9\[{]|-[0-9]|true|false|null)/;
export function diagnosis_looksLikeJSON(value : string) {
    return FAST_JSON_DETECTOR_REGEXP.test(value);
}

export function diagnosis_looksLikeHTML(value : string) {
    if(typeof value !== "string") {
        return false;
    }
    return value.startsWith("<!DOCTYPE html") || value.startsWith("<html") || value.startsWith("<HTML")
}

export type RestErrorOptions = ErrorOptions & {
    /**
     * Set the status code that should be send
     */
    httpStatusCode?: number

    /**
     * You can explicitly enable or disable logging for this error.
     * undefined = controlled by global setting {@see RestfuncsOptions.logErrors}
     */
    log?: boolean
}

/**
 * These Errors will get sent to the client with their full errormessage while normal Errors wold usually be concealed. {@see RestfuncsOptions.exposeErrors}
 * Also you can specify the http status code in the options.
 * Also custom properties will (always) be sent to the client.
 *
 * You may use these to indicate special situations that should be reacted to. I.e. A 'class NotLoggedinError extends RestError' that would trigger a login popup dialog.
 *
 * Note that on the client you will catch it wrapped in a 'ServerError' so you'll find this RestError under the .cause property.
 */
export class RestError extends Error {
    public httpStatusCode?: number;

    /**
     * Redundant indicator that this is a RestError (sub-) class because an 'instanceof RestError' strangely does not work across different packages.
     */
    public isRestError= true;

    public log?: boolean;

    constructor(message: string, options?: RestErrorOptions ) {
        super(message, options);
        this.httpStatusCode = options?.httpStatusCode;
        this.log = options?.log;
    }
}

function isRestError(error: Error) {
    // @ts-ignore
    return error.isRestError
}

/**
 * Return If req might be a [simple](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests) request.
 *
 * Not all headers are checked, so rather returns true / triggers security alarm.
 *
 * @param req
 */
function couldBeSimpleRequest(req: Request) {
    const [contentType] = parseContentTypeHeader(req.header("Content-Type"));
    return (req.method === "GET" || req.method === "HEAD" || req.method === "POST") &&
        (!contentType || contentType === "application/x-www-form-urlencoded" || contentType === "multipart/form-data" || contentType === "text/plain") &&
        req.header("IsComplex") !== "true"

}


/**
 *
 * @param req
 * @return proto://host[:port] of the origin
 */
function getOrigin(req: Request) : string | undefined {
    if(req.header("Origin")) {
        return req.header("Origin")
    }

    const referer = req.header("Referer");
    if(referer) {
        const refererUrl = URL.parse(referer);
        if(refererUrl.protocol && refererUrl.host) {
            return refererUrl.protocol + "//" + refererUrl.host;
        }
    }
}

/**
 *
 * @param req
 * @return proto://host[:port] of the destination. Or undefined if not (reliably) determined
 */
function getDestination(req: Request) : string | undefined {
    /**
     * In express 4.x req.host is deprecated but req.hostName only gives the name without the port, so we have to work around as good as we can
     */
    function getHost() {
        // @ts-ignore
        if(!req.app) {
            return undefined;
        }

        if(req.app.enabled('trust proxy')) {
            return undefined; // We can't reliably determine the port
        }

        return req.header('Host');
    }

    const host = getHost();

    if(!req.protocol || !host) {
        return undefined;
    }

    return req.protocol + "://" + host;
}

/**
 *
 * @param req
 * @param options
 * @return if origin and destination are allowed by the "allowedOrigins" option
 */
function originIsAllowed(req: Request, options: RestfuncsOptions): boolean {
    const origin = getOrigin(req);
    const destination = getDestination(req);

    function isSameOrigin() {
        return destination !== undefined && origin !== undefined && (origin === destination);
    }

    if(!options.allowedOrigins) { // Only same origin allowed ?
        return isSameOrigin()
    }
    else if(_.isArray(options.allowedOrigins)) {
        return isSameOrigin() || (origin !== undefined && _(options.allowedOrigins).contains(origin));
    }
    else if(typeof options.allowedOrigins === "function") {
        return options.allowedOrigins(origin, destination);
    }
    else if(options.allowedOrigins === "all") {
        return true;
    }
    else {
        throw new Error("Invalid value for allowedOrigins: " + options.allowedOrigins)
    }

    return false;
}


function browserSupportsCORS(req: Request, error_hints?: string[]) {
    return true; // TODO
}

/**
 * Returns if methodName is allowed to access the session or run credentialed via client-cert / basic auth
 * Will return false for possibly forged requests
 * @param methodName The method / function name that's (about to be) called
 * @param req
 * @param options Controls how restrictive the checks should be / which origins are allowed
 * @param restService
 * @param error_hints error hints will be added here
 */
function methodIsAllowedCredentialed(methodName: string, req: Request, options: RestfuncsOptions, restService: RestService, error_hints: string[]): boolean {
    // note that this this called from 2 places: On the beginning of a request. And before an actual session access with a (faked) defined options.csrfProtection.

    /**
     * is the corsReadToken or csrfToken valid ?
     */
    function tokenValid(): boolean {
        // TODO
        error_hints.push("Invalid token"); // TODO

        return false;
    }

    // Check protection mode compatibility:
    if(options.csrfProtection !== undefined) { // csrfProtection is enforced ?
        const clientProtectionMode = undefined // TODO
        if (clientProtectionMode !== options.csrfProtection) { // Client and server want different protection modes  ?
            error_hints.push(`The server requires x , while your request y ...`)
            return false;
        }
    }

    if(options.csrfProtection === "csrfToken") {
        return tokenValid(); // Strict check already here.
    }

    if(originIsAllowed(req, options)) {
        return true
    }

    // diagnosis:
    error_hints.push(diagnosis_originNotAllowedMessage(req)) // TODO: add hints into originIsAllowed function
    if(false) { // TODO x-forwarded-by header == getDestination(req)
        // error_hints.push(`it seems like your server is behind a reverse proxy and therefore the server side same-origin check failed. If this is the case, you might want to add ${x-forwarded-by header} to RestfuncsOptions.allowedOrigins`)
    }

    // The server side origin check failed but the request could still be legal:
    // In case of same-origin requests: Maybe our originAllowed assumption was false negative (because behind a reverse proxy) and the browser knows better.
    // Or maybe the browser allows non-credentialed requests to go through (which can't do any security harm)
    // Or maybe some browsers don't send an origin header (i.e. to protect privacy)

    if(!browserSupportsCORS(req, error_hints)) {
        return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
    }

    if(options.csrfProtection === "corsReadToken") {
        if(tokenValid()) {  // Read was proven ?
            return true;
        }
    }

    if (couldBeSimpleRequest(req)) { // Simple request (or a false positive non-simple request)
        // Simple requests have not been preflighted by the browser and could be cross-site with credentials (even ignoring same-site cookie)
        if(req.method === "GET" && restService.methodIsSafe(methodName)) {
            return true // Exception is made for GET to a @safe method. These don't write and the results can't be read (and for the false positives: if the browser thinks that it is not-simple, it will regard the CORS header and prevent reading)
        }
        else {
            // Block

            // Add special error_hints:
            let diagnosis_acceptedResponseContentTypes = [...(req.header("Accept")?.split(",") || [])];
            diagnosis_acceptedResponseContentTypes.map(value => value.split(";")[0]) // Remove the ";q=..." (q-factor weighting). We just simply go by order


            const [contentType] = parseContentTypeHeader(req.header("Content-Type"));
            if (contentType == "application/x-www-form-urlencoded" || contentType == "multipart/form-data") { // SURELY came from html form ?
            }
            else if(req.method === "GET" && getOrigin(req) === undefined && _(diagnosis_acceptedResponseContentTypes).contains("text/html") ) { // Top level navigation in web browser ?
                error_hints.push(`GET requests to '${methodName}' from top level navigations (=having no origin)  are not allowed because '${methodName}' is not considered safe.`);
                error_hints.push(`If you want to allow '${methodName}', make sure it contains only read operations and decorate it with @safe(). Example:\n\nimport {safe} from "restfuncs-server";\n...\n@safe() // <-- read JSDoc \nfunction ${methodName}(...) {\n    //... must perform non-state-changing operations only\n}`)
                if(diagnosis_methodWasDeclaredSafeAtAnyLevel(restService.constructor, methodName)) {
                    error_hints.push(`NOTE: '${methodName}' was only decorated with @safe() in a parent class, but it is missing on your *overwritten* method.`)
                }
            }
            else if(req.method === "GET" && getOrigin(req) === undefined) { // Crafted http request (maybe from in web browser)?
                error_hints.push(`Also when this is from a crafted http request (written by you), you may set the 'IsComplex' header to 'true' and this error will go away.`);
            }
            else if (contentType == "text/plain") { // MAYBE from html form
                error_hints.push(`Also when this is from a crafted http request (and not a form), you may set the 'IsComplex' header to 'true' and this error will go away.`);
            }
            else if(req.method !== "GET" && getOrigin(req) === undefined) { // Likely a non web browser http request (or very unlikely that a web browser will send these as simple request without origin)
                error_hints.push(`You have to specify a Content-Type header.`);
            }
            return false; // Block
        }
    }
    else { // Surely a non-simple request ?
        // *** here we are only secured by the browser's preflight ! ***

        if(methodName === "getReadToken") {
            return true;
        }

        if(options.csrfProtection === undefined || options.csrfProtection === "preflight") {
            return true; // Trust the browser that it would bail after a negative preflight
        }
    }

    return false;
}

const diagnosis_originNotAllowedMessage = (req: Request) => `Request is not allowed from ${getOrigin(req) || "<unknown / no headers present>"} to ${getDestination(req)}. See the allowedOrigins setting in the RestfuncsOptions. \nAlso if you app server is behind a reverse proxy and you think the resolved proto/host/port of '${getDestination(req)}' is incorrect, check the trust proxy settings: http://expressjs.com/en/4x/api.html#app.settings.table`;

/**
 * Pre checks some of the fields to give meaningful errors in advance.
 * @param options
 */
function checkOptionsValidity(options: RestfuncsOptions) {
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
}