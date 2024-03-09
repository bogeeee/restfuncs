// Diagnosis for web packagers. Please keep this at the file header:
import {Buffer} from 'node:buffer'; // *** If you web packager complains about this line, it did not properly (tree-)shake off your referenced ServerSession class and now wants to include ALL your backend code, which is not what we want. It can be hard to say exactly, why it decides to follow (not tree-shake) it, so Keep an eye on where you placed the line: `new RestfuncsClient<YourServerSession>(...)` or where you included YourServerSession in a return type. **
import express, {Request, Response, Router} from "express";
import _ from "underscore";
import {reflect, ReflectedMethod, ReflectedMethodParameter} from "typescript-rtti";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import URL from "url"
import {
    browserMightHaveSecurityIssuseWithCrossOriginRequests,
    Camelize,
    cloneError,
    couldBeSimpleRequest,
    diagnisis_shortenValue, diagnosis_hasDeepNullOrUndefined,
    diagnosis_looksLikeHTML,
    diagnosis_looksLikeJSON,
    enhanceViaProxyDuringCall,
    ERROR_PROPERTIES,
    errorToHtml,
    errorToString,
    ErrorWithExtendedInfo,
    fixErrorStack,
    fixTextEncoding,
    getDestination,
    getOrigin,
    isTypeInfoAvailable,
    parseContentTypeHeader,
    shieldTokenAgainstBREACH,
    shieldTokenAgainstBREACH_unwrap
} from "./Util";
import escapeHtml from "escape-html";
import crypto from "node:crypto"
import {getServerInstance, PROTOCOL_VERSION, RestfuncsServer, SecurityGroup} from "./Server";
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify";
import {Readable} from "node:stream";
import {CommunicationError, isCommunicationError} from "./CommunicationError";
import busboy from "busboy";
import {AsyncLocalStorage} from 'node:async_hooks'
import {
    CookieSession, CookieSessionState,
    CookieSessionUpdate,
    CSRFProtectionMode,
    GetCookieSessionAnswerToken,
    GetCookieSession_question,
    GetHttpSecurityProperties_answer,
    GetHttpSecurityProperties_question,
    IServerSession,
    SecurityPropertiesOfHttpRequest,
    ServerPrivateBox,
    WelcomeInfo
} from "restfuncs-common";
import {ServerSocketConnection,} from "./ServerSocketConnection";
import nacl_util from "tweetnacl-util";
import nacl from "tweetnacl";
import typia, {IValidation} from "typia"

Buffer.alloc(0); // Provoke usage of some stuff that the browser doesn't have. Keep this here !

const COMPATIBLE_TRANSFORMER_MAJOR_VERSION = 1;
const REQUIRED_TRANSFORMER_FEATURE_VERSION = 1;

export type ClientCallback = ((...args: unknown[]) => void) & {};

export type RegularHttpMethod = "GET" | "POST" | "PUT" | "DELETE";
export type ParameterSource = "string" | "json" | null; // Null means: Cannot be auto converted

export type AllowedOriginsOptions = undefined | "all" | string[] | ((origin?: string) => boolean);
export type ServerSessionOptions = {

    /**
     * Enable basic auth by specifying a function that returns true if username+password is allowed.
     * <p>
     * Setting it to "ignoresHeader" confirms that your code inside this service does not evaluate the Basic Auth http header (whilst it was intended for other services). Therefore restfuncs will not complain when using a client-decided CSRF protection mode.
     * </p>
     * TODO: implement. Maybe instead of ignoresHeader, react on a hook when the header is accessed.
     */
    basicAuth?: ((user: string, password: string) => boolean) | "ignoresHeader"

    /**
     * Whether errors during call should be logged to the console.
     * You can supply a logger function
     * Default: true
     */
    logErrors?: boolean | ((message: string, context?: {req?: Request, socketConnection?: ServerSocketConnection}) => void)

    /**
     * Whether to show/expose error information to the client:
     * - true: Exposes ALL error messages + stacks. Enable this for development (default for development).
     * - "messagesOnly": Exposes only the message/title + class name. But no stack or other info.
     * - "RestErrorsOnly" (default): Like messageOnly but only for subclasses of {@see CommunicationError}. Those are intended to aid the interface consumer.
     * - false: No information is exposed. The client will get a standard Error: "Internal server error".
     *
     *  User defined SUB- classes of {@see CommunicationError} will always fall through this restriction and have their message, name and custom properties exposed.
     *  I.e. You could implement a 'class NotLoggedInException extends CommunicationError' as in indicator to trigger a login form.
     */
    exposeErrors?: true | "messagesOnly" | "RestErrorsOnly" | false

    /**
     * Makes the JSDoc and all parameter descriptions of all your @remote methods available to the public via the API browser or via the ./metadata service.
     * <p>This feature is not yet implemented, but it will come without notice / in a minor version update, so be aware of the default !
     * </p>
     * <p>
     * Default: true
     * </p>
     */
    exposeMetadata?: boolean

    /**
     * Web browser security: <strong>Which origins are allowed to make calls ?</strong>
     *
     * These origins will share the credentials (cookies, basic auth, ...) and therefore the user's session !
     *
     * Change this option if you:
     *  - Host the backend and frontend on different (sub-) domains.
     *  - Provide authentication methods to other web applications.
     *  - Consume authentication responses from 3rd party authentication providers. I.e. form- posted SAML responses.
     *  - Provide services to other web applications (that need the current user's session).
     *  - Have a reverse proxy in front of this web app and you get an error cause the same-origin check fails for simple, non preflighted, requests like form posts. Alternatively check the trust proxy settings: http://expressjs.com/en/4x/api.html#app.settings.table (currently this does not work properly with express 4.x)
     *
     * Values:
     * - undefined (default): Same-origin only
     * - string[]: List the allowed origins: http[s]://host[:port]. Same-origin is always implicitly allowed
     * - "all": No restrictions
     * - function: A function (origin?: string) => boolean that returns, if it should be allowed. Args are in the form: http[s]://host[:port]. Note: If you have multiple ServerSessions (for better organization) that have the same origins, make sure to pass them the same function <strong>instance</strong>. I.e. don't create the function in a closure. Otherwise, restfuncs can't know better and has to put the ServerSessions in different security groups, which results in performance and cookie-size penalties.
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
     * - implement the access token logic yourself, see {@link ServerSession.proofRead()}
     * - disable this feature and trust on browsers to make preflights and bail if they fail.
     *
     * Note: For client developers with tokenized modes: You may wonder wonder why some requests will still pass without token checks. They may be already considered safe according the the origin/referrer headers or when the remote method is flagged with `isSafe`.
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
     * Disables all argument- and output validation and CSRF protection checks and CORS allows all origins.
     * Default: true when NODE_ENV==development, otherwise false
     */
    devDisableSecurity?: boolean


    /**
     * Advanced (very): Enable this, if you want to throw other things than Errors from the server to the client.
     *
     * This should be very rare or occur by accident and we don't want to expose unwanted information to the client then. Therefore this feature is disabled by default.
     */
    allowThrowNonErrors?: boolean
}

type ObjectWithStringIndex = {[index: string]: unknown};

/**
 * Values that are allowed to be set as meta parameters via header / query params / request body params.
 */
export const metaParameterNames = new Set<string>(["csrfProtectionMode", "corsReadToken", "csrfToken", "shapeArguments"])
export const DOCS_BASEURL = "https://github.com/bogeeee/restfuncs/tree/3.x"
export const DOCS_READMEURL = `${DOCS_BASEURL}/readme.md`

export type SecurityRelevantSessionFields = {
    /**
     * Can be undefined if nothing has yet been written, or if the client(s) don't explicitly specify a mode
     */
    csrfProtectionMode?: CSRFProtectionMode

    /**
     * One for each service
     * ServerSession id -> token
     */
    corsReadTokens?: Record<string, string>

    /**
     * One for each service
     *
     * ServerSession id -> token
     */
    csrfTokens?: Record<string, string>
};

type ClassOf<T> = {
    new(...args: unknown[]): T
}

type RemoteMethodsMeta = {
    transformerVersion: {major: number,  feature: number },
    instanceMethods: {
        [methodName: string]: {
            arguments: {
                validateEquals: (args: unknown[]) => IValidation<unknown[]>
                validatePrune:  (args: unknown[]) => IValidation<unknown[]>
            }
            result: {
                validateEquals: (result: unknown) => IValidation<unknown>
                validatePrune:  (result: unknown) => IValidation<unknown>
            }
            jsDoc?: {
                comment: string,
                params: Record<string, string>
                /**
                 * I.e.
                 * "@see ..."
                 */
                tags: {name:string, comment?: string}[]
            }
        }
    }
}

/**
 * A remote interface / session.
 * All (instance) @remote() methods can be called via http / sockets from the public.
 * All (instance) fields are stored in the cookie session.
 * <p>
 *     Technically, instances are not created for every session, but for every request. But that should not need to bother you.
 * </p>
 * <p>
 * To use it, see {@link createExpressHandler}. See the main readme.md for a usage concept.
 * </p>
 */
export class ServerSession implements IServerSession {
    //[index: string]: unknown // This prevents annoying "any can't be used to index ServerSession" typescript error. But on the other hand typescript does not complain about missing properties then

    /**
     * Uniquely identify this class. An id is needed to store corsReadTokens and csrfTokens in the session, bound to a certain service (imagine different services have different allowedOrigings so we can't have one-for-all tokens).
     * Normally the class name is used and not a random ID, cause we want to allow for multi-server environments with client handover
     *
     * Change the implementation if you need to support multiple ServerSession classes with the same name.
     */
    static get id(): string {
        if(this.hasOwnProperty("_id") && this._id) { // Already computed at this level ?
            return this._id;
        }
        return this._id = this.generateId();
    }

    private static _id?: string;

    /**
     * The options.
     * <p>
     * <i>If it's more handy to set these from your server.ts, you can do so <strong>before</strong> the first call to {@link ServerSession#createExpressHandler()}</i>
     * </p>
     */
    static options: ServerSessionOptions = {};

    /**
     * Don't use. Use the <strong>static</strong> field instead.
     */
    options?: never;

    /**
     * Some RemoteMethodOptions fields allow you to specify defaults on the class level.
     * See each field's description, if and how the defaulting mechanism works.
     * <p>
     * Example Usage:
     * </p>
     * <pre><code>
     *     class MyServerSession extends ServerSession {
     *         static defaultRemoteMethodOptions: RemoteMethodOptions = {shapeArguments: true, ...}
     *     }
     * </code></pre>
     * @protected
     */
    protected static defaultRemoteMethodOptions?: RemoteMethodOptions

    /**
     * Internal: Filled on decorator loading time: for each concrete subclass such a static field is created
     */
    protected static remoteMethod2Options?: Map<string, RemoteMethodOptions>

    //*********************************************
    //*** <Helpers for the restfuncs-transformer>
    //*********************************************

    /**
     * Fixes the situation where typescript complains because a sub-subclass' getRemoteMethodsMeta does not satifiy all members of the parent (i.e. it doesn't list a method that the parent has).
     * Therefore we make the returntype fixed
     * @protected
     */
    protected static type_remoteMethodsMeta: RemoteMethodsMeta;

    /**
     * Transformer: Serve reference to typia for generated code. Cause adding the "import ..." clause is too much effort
     * @protected
     */
    protected static typiaRuntime = typia;

    /**
     * Diagnosis: Helps the transformer output a proper message.
     * @protected
     */
    protected static __hello_developer__make_sure_your_class_is_a_subclass_of_ServerSession = undefined;

    //*********************************************
    //*** </Helpers for the restfuncs-transformer>
    //*********************************************

    /**
     * @returns Genrated functions for fast runtime validation of the @remote methods. I.e. the "validate" function is generated by typia.
     * The restfuncs-transformer + typia transformer chain will generate these for all subclasses.
     * @protected
     */
    protected static getRemoteMethodsMeta(): RemoteMethodsMeta {
        throw new Error("This is not generated");
    }


    /**
     * The id of the cookie or null if no cookie is used yet (nothing written to this session yet). Security: It is readable from inside the browser.
     */
    readonly id?: CookieSession["id"]

    readonly version?: number

    /**
     * Context information about the current remote method call.
     *
     * It is made available through a proxied 'this' during call time.
     *
     * @protected
     */
    protected call!: {

        /**
         * Express's req object, when called directly via http (not via socket). See {@link https://expressjs.com/en/4x/api.html#req}
         */
        req?: Omit<Request, "session"> & {
            /**
             * @deprecated <strong>Caution:</strong> Accessing the *raw* session is not CSRF protected. Use the ServerSession's fields instead.
             */
            session: Request["session"];
        },

        /**
         * Express's res object, when called directly via http (not via socket). You can modify any header fields as you like. See {@link https://expressjs.com/en/4x/api.html#res}
         */
        res?: Response;


        /**
         * The connection to the client, that made the call via engine.io / websockets.
         */
        socketConnection?: ServerSocketConnection

        /**
         * These are also available from calls through the socket connection
         */
        securityProps: Readonly<SecurityPropertiesOfHttpRequest>
    }

    /**
     * Type hint.
     * <p/>
     * In order to make your special static subclass members available via <code>this.clazz</code>, you must help typescript a bit by redefining this field with the follwing line:
     * </p>
     * <pre><code>
     *     classType!: typeof YOUR-SERVERSESSION-SUBCLASS;
     * </code></pre>
     */
    classType!: typeof ServerSession

    /**
     * Must have a no-args constructor
     */
    constructor() {
    }

    /**
     * Pre checks some of the fields to give meaningful errors in advance.
     * Internal.
     * @param options
     */
    protected static checkOptionsValidity(options: ServerSessionOptions) {
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

        // Check that type info is available
        if(!this.isSecurityDisabled) {
            if(!isTypeInfoAvailable(new this)) {
                throw new CommunicationError("Runtime type information is not available.\n" + this._diagnosis_HowToSetUpTheBuild())
            }
        }
    }

    private static _referenceInstance?: ServerSession

    /**
     * The (single) instance to compare against, so you can check if any fields were modified.
     * @protected
     */
    static get referenceInstance() {
        if(this.hasOwnProperty("_referenceInstance") && this._referenceInstance /* note: there's a different behaviour when run with a transformProgram transformer: the compiler will then emit static _reference = undefined (vs. leaving this line away) */) { // Already initialized ?
            return this._referenceInstance!;
        }

        const result = new this;

        // Safety check, if instantiation is deterministic:
        let serverSessionBase = new ServerSession();
        const anotherInstance = new this;
        for(const k in result) {
            const key = k as keyof ServerSession;
            if (!_.isEqual(result[key], anotherInstance[key])) {
                throw new Error(`Creating a new ${this.name} instance is not deterministic. Field ${key} has a different value each time. If you want to store things like generated ids, create them lazily, i.e. via a get accessor. \nNote: this is needed for detecting actual changes to the session and lazy cookie behaviour. \n`)
            }
        }

        return this._referenceInstance = result;
    }

    /**
     * Creates a handler that allows all (instance-) @remote methods to be called by http. This can be by the restfuncs client.
     * <p>
     *     The structure of this method is explained in 'ServerSession breakdown.md'
     * </p>
     */
    static createExpressHandler(): Router {

        this.checkOptionsValidity(this.options); // Do some global checks:

        this.server.registerServerSessionClass(this); // Make sure, this is registered

        const router = express.Router();

        router.use(express.raw({limit: Number.MAX_VALUE, inflate: false, type: req => true})) // parse application/brillout-json and make it available in req.body

        router.use(async (req, res, next) => {
            let acceptedResponseContentTypes = [...(req.header("Accept")?.split(",") || []), "application/json"]; // The client sent us a comma separated list of accepted content types. + we add a default: "application/json"
            acceptedResponseContentTypes.map(value => value.split(";")[0]) // Remove the ";q=..." (q-factor weighting). We just simply go by order

            let cleanupStreamsAfterRequest: (() => void) | undefined = undefined

            /**
             * Http-sends the result, depending on the requested content type:
             */
            const sendResult = (result: unknown, diagnosis_methodName?: string) => {
                const contextPrefix = diagnosis_methodName ? `${diagnosis_methodName}: ` : ""; // Reads better. I.e. the user doesnt see on first glance that the error came from the getIndex method

                // Determine contentTypeFromCall: The content type that was explicitly set during the call via res.contentType(...):
                const contentTypeHeader = res.getHeader("Content-Type");
                if(typeof contentTypeHeader == "number" || _.isArray(contentTypeHeader)) {
                    throw new Error(`${contextPrefix}Unexpected content type header. Should be a single string`);
                }
                const [contentTypeFromCall, contentTypeOptionsFromCall] = parseContentTypeHeader(contentTypeHeader);

                if(contentTypeFromCall == "application/brillout-json") {
                    res.send(brilloutJsonStringify(result));
                }
                else if(contentTypeFromCall == "application/json") {
                    res.json(result);
                }
                else if(contentTypeFromCall) { // Other ?
                    if(typeof result === "string") {
                        res.send(result);
                    }
                    else if(result instanceof Readable) {
                        if(result.errored) {
                            throw result.errored;
                        }
                        result.on("error", (err) => {
                            res.end(this.logAndGetErrorLineForPasteIntoStreams(err, req));
                        })
                        result.pipe(res);
                    }
                    else if(result instanceof ReadableStream) {
                        throw new CommunicationError(`${contextPrefix}ReadableStream not supported. Please use Readable instead`)
                    }
                    else if(result instanceof ReadableStreamDefaultReader) {
                        throw new CommunicationError(`${contextPrefix}ReadableStreamDefaultReader not supported. Please use Readable instead`)
                    }
                    else if(result instanceof Buffer) {
                        res.send(result);
                    }
                    else {
                        throw new CommunicationError(`For Content-Type=${contentTypeFromCall}, ${diagnosis_methodName || "you"} must return a result of type string or Readable or Buffer. Actually got: ${diagnisis_shortenValue(result)}`)
                    }
                }
                else { // Content type was not explicitly set in the call ?
                    if(result instanceof Readable || result instanceof ReadableStream || result instanceof ReadableStreamDefaultReader || result instanceof Buffer) {
                        throw new CommunicationError(`${contextPrefix}If you return a stream or buffer, you must explicitly set the content type. I.e. via: this.call.res?.contentType(...); `);
                    }

                    // Send what best matches the Accept header (defaults to json):
                    acceptedResponseContentTypes.find((accept) => { // Iterate until we have handled it
                        if (accept == "application/brillout-json") { // The better json ?
                            res.contentType("application/brillout-json")
                            res.send(brilloutJsonStringify(result));
                        }
                        else if(accept == "application/json") {
                            result = result!==undefined?result:null; // Json does not support undefined
                            res.json(result);
                        }
                        else if(accept == "text/html") {
                            if(diagnosis_looksLikeHTML(result)) {
                                throw new CommunicationError(`${contextPrefix}If you return html, you must explicitly set the content type. I.e. via: this.call.res?.contentType(\"text/html; charset=utf-8\"); `);
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
                res.header("Expires","-1");
                res.header("Pragma", "no-cache");

                res.header("restfuncs-protocol",  PROTOCOL_VERSION); // Let older clients know when the interface changed
                res.header("Access-Control-Expose-Headers", "restfuncs-protocol")

                if(req.method !== "GET" && req.method !== "POST" && req.method !== "PUT" && req.method !== "DELETE" && req.method !== "OPTIONS") {
                    throw new CommunicationError("Unhandled http method: " + req.method)
                }

                const origin = getOrigin(req);
                const diagnosis_originNotAllowedErrors: string[] = []
                const originAllowed =  originIsAllowed({origin, destination: getDestination(req), allowedOrigins: this.options.allowedOrigins}, diagnosis_originNotAllowedErrors) || this.isSecurityDisabled
                // Answer preflights:
                if(req.method === "OPTIONS") {
                    if(originAllowed) {
                        if(req.header("Access-Control-Request-Method")) { // Request is a  CORS preflight (we don't care which actual method) ?
                            res.header("Access-Control-Allow-Origin", origin)
                            res.header("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,DELETE")
                            res.header("Access-Control-Allow-Headers", ["content-type", "accept", "iscomplex", ...Array.from(metaParameterNames).map(v=> v.toLowerCase())].join(", "));
                            res.header("Access-Control-Allow-Credentials", "true")

                            res.header("Vary", "Origin")
                            //res.header("Access-Control-Max-Age", "3600") // Stick with the defaults / pros + cons not researched

                            res.status(204);
                        }
                    }
                    else {
                        throw new CommunicationError(diagnosis_originNotAllowedErrors.join("; "));
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

                this.server.getComputed(); // Error diagnosis / workaround: getComputed may be called the first time through the engine.io -> cors handler -> isAllowed but in that case the error is swallowed. Therefore at this place, we can nicely display it to the user.

                // Obtain cookieSession:
                let cookieSession = this.getFixedCookieSessionFromRequest(req);
                // TODO: this should go into our JWT cookie handler
                // Validate cookieSession
                if(cookieSession && !(await this.server.cookieSessionIsValid(cookieSession))) { // cookieSession is invalid ?
                    await this.regenerateExpressSession(req);
                    cookieSession = this.getFixedCookieSessionFromRequest(req);
                    if(cookieSession !== undefined) {
                        throw new Error("Illegal state: fresh cookieSession is not undefined.");
                    }
                }

                // retrieve method name:
                const fixedPath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
                let methodNameFromPath = fixedPath.split("/")[0];
                const remoteMethodName = this.getMethodNameForCall(req.method, this.prototype, methodNameFromPath);
                if(!remoteMethodName) {
                    if(!methodNameFromPath) {
                        throw new CommunicationError(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`)
                    }
                    throw new CommunicationError(`No method candidate found for ${req.method} + ${methodNameFromPath}.`)
                }

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

                if(this.options.devForceTokenCheck) {
                    const strictestMode = this.options.csrfProtectionMode || (<SecurityRelevantSessionFields> req.session)?.csrfProtectionMode || securityPropertiesOfRequest.csrfProtectionMode; // Either wanted explicitly by server or by session or by client.
                    if(strictestMode === "corsReadToken" || strictestMode === "csrfToken") {
                        // Enforce the early check of the token:
                        this.checkIfRequestIsAllowedCrossSite(securityPropertiesOfRequest, strictestMode, (origin) => false, <SecurityRelevantSessionFields> req.session, remoteMethodName, {
                            http: {
                                acceptedResponseContentTypes,
                                contentType: parseContentTypeHeader(req.header("Content-Type"))[0],
                            },
                            isSessionAccess: false
                        })
                    }
                }

                // Do the call:
                let { result, modifiedSession} = await this.doCall_outer(cookieSession, securityPropertiesOfRequest, remoteMethodName, methodArguments, {req, res, securityProps: securityPropertiesOfRequest}, metaParams["shapeArguments"] === "true",{
                    http: {
                        acceptedResponseContentTypes,
                        contentType: parseContentTypeHeader(req.header("Content-Type"))[0]
                    },
                });

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
                        else if(accept == "text/html") {
                            res.contentType("text/html; charset=utf-8")
                            res.send(`<!DOCTYPE html><html>${errorToHtml(error)}${"\n"}<!-- HINT: You can have JSON here when setting the 'Accept' header tp application/json.--></html>`);
                        }
                        else if(accept.startsWith("text/")) {
                            res.contentType(`text/plain; charset=utf-8`)
                            res.send(errorToString(error))
                        }
                        else {
                            return false; // not handled ?
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
     * req.session is unset after that.
     * <p>
     * Internal. Do not override
     * </p>
     * @param req
     * @param res headers will be added here to indicate, see {@link CookieSessionState}
     */
    private static async destroyExpressSession(req: Request, res: Response) {
        if(req.session === undefined) { // Either destroyed or no session handler installed
            return;
        }

        await new Promise<void>((resolve, reject) => {
            req.session.destroy(err => {
                if(err) {
                    reject(err);
                }
                else {
                    resolve()
                }
            });
        })

        if(req.session) {
            throw new Error("Illegal state. Session should be unset");
        }

        this.sendCookieSessionState(req, res, true);
    }

    /**
     *
     * @param modifiedSession modified fields.
     * @param req
     * @param res headers will be added here to indicate, see {@link CookieSessionState}
     * @private
     */
    private static updateAndSendReqSession(modifiedSession: Omit<CookieSession, "id">, req: Request, res: Response) {
        modifiedSession = {...modifiedSession} // Copy, so the method does not have side effects
        delete modifiedSession.id // Make sure the id is really removed.

        this.ensureSessionHandlerInstalled(req);
        _(req.session).extend(modifiedSession);

        if(!req.session.id) {
            throw new Error("Session should have an id by now");
        }

        this.sendCookieSessionState(req, res)
    }

    /**
     * Inits / increases the version field and fills the bpSalt fields
     * @param cookieSession
     * @private
     */
    private static increaseCookieSessionVersion(cookieSession: Partial<CookieSession>) {
        if(typeof cookieSession.version !== "number") {
            cookieSession.version = 0;
        }
        cookieSession.version = cookieSession.version+1;
        cookieSession.previousBpSalt = cookieSession?.bpSalt
        cookieSession.bpSalt = this.createBpSalt();
    }

    /**
     * See {@link CookieSessionState}
     * @param isDestroyed Set this, if you know that you just destroyed it. Cause we might not be able to detect it otherwise
     */
    private static sendCookieSessionState(req: Request, res: Response, isDestroyed?: boolean) {
        const cookieSession = isDestroyed?undefined:this.getFixedCookieSessionFromRequest(req)
        if(cookieSession) {
            const state: CookieSessionState = {
                id: cookieSession.id,
                version: cookieSession.version
            }
            const stateJson = JSON.stringify(state);
            res.header("Set-Cookie", `rfSessState=${stateJson}; Path=/`)
        }
        else {
            res.header("Set-Cookie", `rfSessState=; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/`) // clears the cookie
        }
    }

    /**
     * Internal. Do not override
     * @param req
     */
    static async regenerateExpressSession(req: Request) {
        await new Promise<void>((resolve, reject) => {
            req.session.regenerate(err => {
                if(err) {
                    reject(err);
                }
                else {
                    resolve()
                }
            });
        })

        if(!req.session) {
            throw new Error("Illegal state. Session should still be set");
        }
    }

    /**
     * This method is the entry point that's called by both: http request and socket connection.
     * Does various stuff / look at the implementation. <p>Internal: Override {@link doCall} instead.</p>
     * <p>
     *     The structure of this method is explained in 'ServerSession breakdown.md'
     * </p>
     * @param cookieSession
     * @param securityPropertiesOfHttpRequest
     * @param remoteMethodName
     * @param methodArguments
     * @param call the properties that should be made available for the user during call time. like req, res, ...
     * @param shapeArguments_clientPreference does the client prefer to shape the arguments (=trim extra properties) ?
     * @param diagnosis
     * @private
     * @returns modifiedSession is returned, when a deep session modification was detected. With updated version field
     */
    static async doCall_outer(cookieSession: CookieSession | undefined, securityPropertiesOfHttpRequest: SecurityPropertiesOfHttpRequest, remoteMethodName: string, methodArguments: unknown[], call: ServerSession["call"], shapeArguments_clientPreference: boolean, diagnosis: Omit<CIRIACS_Diagnosis, "isSessionAccess">) {

        // Check, if call is allowed if it would not access the cookieSession, with **general** csrfProtectionMode:
        {
            const cookieSessionParam = cookieSession as SecurityRelevantSessionFields || {}; // _Don't know why typescript complains without a cast, as SecurityRelevantSessionFields has all props optional_
            this.checkIfRequestIsAllowedCrossSite(securityPropertiesOfHttpRequest, this.options.csrfProtectionMode, this.options.allowedOrigins, cookieSessionParam, remoteMethodName, {
                ...diagnosis,
                isSessionAccess: false
            });
        }

        const remoteMethodOptions = this.getRemoteMethodOptions(remoteMethodName);

        // Instantiate a serverSession:
        const referenceInstance = this.referenceInstance; // Make sure that lazy field is initialized before creating the instance. At least this is needed for the testcases
        let serverSession: ServerSession = new this();

        serverSession.validateCall(remoteMethodName, methodArguments, remoteMethodOptions.shapeArguments !== undefined?remoteMethodOptions.shapeArguments:shapeArguments_clientPreference);

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
            // @ts-ignore cannot use 'protected' field call otherwise
            const enhancementProps: Partial<ServerSession> = {call};
            await enhanceViaProxyDuringCall(guardedServerSession, enhancementProps, async (enhancedServerSession) => { // make call (.req, .res, ...) safely available during call
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
            if(remoteMethodOptions.validateResult !== false) {
                serverSession.validateAndShapeResult(result, remoteMethodName);
            }
        }
        catch (e) {
            // Handle non-errors:
            if(!(e instanceof Error)) { // non-error ?
                if(this.options.allowThrowNonErrors) {
                    throw e;
                }
                else {
                    throw new Error("A non error was thrown: " + diagnisis_shortenValue(e) + "\n If this was intentional and you want it passed to the client, enable SeverSessionOptions#allowThrowNonErrors")
                }
            }
            throw e;
        }

        // Check if modified:
        const modified = Object.keys(serverSession).some(k => {
            const key = k as keyof ServerSession; // Fix type

            if(!cookieSession?.hasOwnProperty(key) && _.isEqual(serverSession[key], referenceInstance[key])) { // property was not yet in the cookieSession and is still the original value
                return false;
            }

            return (!_.isEqual(serverSession[key], cookieSession?cookieSession[key]:undefined))
        });

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
     * @returns The singleton instance. It's either the restfuncsExpress() server, created by the user or an anonymous instance
     */
    static get server(): RestfuncsServer {
        return getServerInstance();
    }

    /**
     * @return The / index- / home page
     */
    @remote({
        isSafe: true,
        validateArguments: false, validateResult: false, shapeArguments: false, shapeResult: false // Disable these, cause we have no type inspection at this class's level
    })
    public async getIndex() {
        let className = this.clazz?.name
        const title = className?`Index of class ${className}`:`Index of {}`

        const example = (className?`class ${className} extends ${this.clazz.superClass?.name} {`:' //...inside your ServerSession class: ') +' \n\n' +
            '    /**\n' +
            `     * Note: When serving rich content / with scripts, you might want to add the 'helmet' middleware in front of ${className || "YourServerSessionClass"} for additional protection via: app.use("/...", helmet(), ${className || "YourServerSessionClass"}.createExpressHandler())\n` +
            '     * @return The / index- / home page\n' +
            '     */\n' +
            '    @remote({isSafe: true})\n' +
            '    getIndex() {\n\n' +
            '        //... you sayed, `isSafe`, so you must perform non-state-changing operations only !\n\n' +
            '        this.call.res?.contentType("text/html; charset=utf-8");\n' +
            '        return "<!DOCTYPE html><html><body>I\'m aliiife !</body></html>"\n' +
            '    }\n\n' +
            '    // ...'


        this.call.res?.contentType("text/html; charset=utf-8");
        return "<!DOCTYPE html>" +
            "<html>" +
            `    <head><title>${escapeHtml(title)}</title></head>` +
            `    <body><h1>${escapeHtml(title)}</h1>` +
            `    This service serves several API methods. You can also fill this index page with life (for simple purposes) by overwriting the getIndex method.<h3>Example</h3><pre>${escapeHtml(example)}</pre>` +
            `    <br/><i>Powered by <a href="https://www.npmjs.com/package/restfuncs">Restfuncs</a></i>` +
            "</body></html>"
    }

    /**
     *
     * Don't override. Not part of the API.
     */
    @remote({validateArguments: false, validateResult: false, shapeArguments: false, shapeResult: false}) // Disable these, cause we have no type inspection at this class's level
    getWelcomeInfo(): WelcomeInfo {
        return {
            classId: this.clazz.id,
            engineIoPath: this.clazz.server.engineIoServers.size > 0?this.clazz.server.getEngineIoPath():undefined
        }
    }


    /**
     * Returns a token which you show in later requests, to prove that your browser allowed requests to this service according to the CORS standard. It made a preflight (if needed) and successfully checked the CORS response headers. The request came from an {@link ServerSessionOptions.allowedOrigins}
     * The created read token is stored in the session (so it can be matched with later requests)
     *
     * <p>
     * <i>Technically, the returned token value may be a derivative of what's stored in the session, for security reasons. Implementation may change in the future. Important for you is only that it is comparable / validatable.</i>
     * </p>
     * <p>
     *     Don't override. Not part of the API.
     * </p>
     */
    @remote({
        validateArguments: false, validateResult: false, shapeArguments: false, shapeResult: false,  // Disable these, cause we have no type inspection at this class's level
        isSafe: false // Don't allow with GET. Maybe an attacker could make an <iframe src="myService/readToken" /> which then displays the result json and trick the user into thinking this is a CAPTCHA
    })
    public getCorsReadToken(): string {
        // Security check that is's called via http:
        if (!this.call.req || this.call.socketConnection) {
            throw new Error("getCorsReadToken was not called via http.");
        }

        const cookieSession = this.clazz.getFixedCookieSessionFromRequest(this.call.req) || {};
        const result = this.clazz.getOrCreateSecurityToken(cookieSession, "corsReadToken");
        this.clazz.updateAndSendReqSession(cookieSession, this.call.req, this.call.res!);
        return result;
    }

    /**
     * Returns the token for this ServerSession class, which is stored in the session. Creates it, if it does not yet exist.
     * <p>
     * <i>Technically, the returned token value may be a derivative of what's stored in the session, for security reasons. Implementation may change in the future. Important for you is only that it is comparable / validatable.</i>
     * </p>
     */
    static getCsrfToken(req: Request, res: Response): string {
        const cookieSession = this.getFixedCookieSessionFromRequest(req) || {};
        const result = this.getOrCreateSecurityToken(cookieSession, "csrfToken");
        this.updateAndSendReqSession(cookieSession, req, res);
        return result;
    }

    /**
     * Internal. Do not override.
     * @param evil_encryptedQuestion
     */
    @remote({validateArguments: false, validateResult: false, shapeArguments: false, shapeResult: false}) // Disable these, cause we have no type inspection at this class's level
    getCookieSession(evil_encryptedQuestion: ServerPrivateBox<GetCookieSession_question>) {
        // Security check:
        if(!this.call.req || this.call.socketConnection) {
            throw new CommunicationError("getCookieSession was not called via http.");
        }
        const question = this.clazz.server.server2serverDecryptToken(evil_encryptedQuestion, "GetCookieSession_question") // does the validation also

        const reqSession = this.call.req!.session as any as Record<string, unknown>;

        if(question.forceInitialize) {
            this.call.req!.session.touch();
            if(!this.call.req!.session.id) {
                throw new Error("Session should have an id by now.")
            }
            reqSession.version = (typeof reqSession.version === "number")?reqSession.version:0, // Like in getFixedCookieSessionFromRequest. Initialize one field, so getFixedCookieSessionFromRequest will detect it as initialized
            this.clazz.updateAndSendReqSession(this.clazz.getFixedCookieSessionFromRequest(this.call.req!)!, this.call.req!, this.call.res!);

            //TODO: we would add it to the validator here
        }

        const cookieSession = this.clazz.getFixedCookieSessionFromRequest(this.call.req!);
        // Safety check
        if(question.forceInitialize && !cookieSession) {
            throw new Error("cookieSession not detected as initialized");
        }

        if(cookieSession && this.clazz.server.serverOptions.installSessionHandler === false) { // Some 3rd party cookiehandler ?
            // getFixedCookieSessionFromRequest may have falsely detected the cookieSession as initialized because it has an id, but the cookie handler could still feature lazy cookies and not send it to the browser (= we would call that not initialized).
            // A false assumption leads to bugs, so we have to make some write to the session, so it will be definitely sent:
            this.call.req!.session.touch();
            _(this.call.req!.session).extend(cookieSession)
        }

        return {
            token: this.clazz.server.server2serverEncryptToken({
                question: question,
                cookieSession: cookieSession
            }, "GetCookieSessionAnswerToken")  ,
            state: this.clazz.getStateOfCookieSession(cookieSession)
        }
    }

    /**
     * Converts the cookieSession into our preferred transfer type: CookieSession | undefined.
     * Fixes the version field.
     * <p>Internal, not part of the API.</p>
     * @param req
     */
    protected static getFixedCookieSessionFromRequest(req: Request) : any {
        if (!req.session) { // No session handler is installed (legal use case)
            return undefined;
        }

        // Detect uninitialized session:
        if (!req.session.id) { // Session is not initialized ?
            return undefined;
        }
        const reqSession = req.session as any as Record<string, unknown>;
        // Detect uninitialized session:
        const standardSessionFields = new Set(["id","cookie", "req"]);
        if(!Object.keys(reqSession).some(key => !standardSessionFields.has(key))) { // Session has only standard fields set ?
            return undefined; // Treat that as uninitialized
        }

        const result: CookieSession =  {
            ...reqSession,
            id: req.session.id, // Re-query that property accessor (otherwise it does not get included)
            version: (typeof reqSession.version === "number")?reqSession.version:0,
            bpSalt: (typeof reqSession.bpSalt === "string")?reqSession.bpSalt: undefined,
        }

        // Remove internal fields from the cookie handler to safe space / cut references:
        delete result["cookie"];
        delete result["req"]

        return result
    }

    private static getStateOfCookieSession(cookieSession: CookieSession | undefined): CookieSessionState {
        return cookieSession?{id: cookieSession.id, version: cookieSession.version}:undefined
    }

    private static createBpSalt() {
        return nacl_util.encodeBase64(nacl.randomBytes(10)); // Un brute-force-able over the network against a single value (non-pool).
    }

    /**
     * Internal. Do no override.
     * @param evil_encryptedQuestion
     */
    @remote({validateArguments: false, validateResult: false, shapeArguments: false, shapeResult: false}) // Disable these, cause we have no type inspection at this class's level
    getHttpSecurityProperties(evil_encryptedQuestion: ServerPrivateBox<GetHttpSecurityProperties_question>): ServerPrivateBox<GetHttpSecurityProperties_answer> {
        // Security check:
        if(!this.call.req || this.call.socketConnection) {
            throw new CommunicationError("getHttpSecurityProperties was not called via http.");
        }
        const question = this.clazz.server.server2serverDecryptToken(evil_encryptedQuestion, "GetHttpSecurityProperties_question") // does the validation also
        // Security check:
        if(question.serverSessionClassId !== this.clazz.id) {
            throw new CommunicationError(`GetHttpSecurityProperties_question is for a different ServerSession class: ${question.serverSessionClassId}`)
        }

        const answer: GetHttpSecurityProperties_answer = {
            question: question,
            result: this.call.securityProps
        }

        return this.clazz.server.server2serverEncryptToken(answer, "GetHttpSecurityProperties_answer")
    }

    /**
     * Called via http, if the socket connection has written to the session, to safe to the real session-cookie
     * <p>
     *     Internal. Do not override
     * </p>
     * @param evil_encryptedCookieSessionUpdate
     * @param evil_alsoReturnNewSession Make a 2 in 1 call to updateCookieSession + {@see getCookieSession}. Safes one round trip.
     */
    @remote({validateArguments: false, validateResult: false, shapeArguments: false, shapeResult: false}) // Disable these, cause we have no type inspection at this class's level
    async updateCookieSession(evil_encryptedCookieSessionUpdate: ServerPrivateBox<CookieSessionUpdate>, evil_alsoReturnNewSession: ServerPrivateBox<GetCookieSession_question>) {
        // Security check:
        if(!this.call.req || this.call.socketConnection) {
            throw new CommunicationError("getHttpSecurityProperties was not called via http.");
        }

        const cookieSessionUpdate = this.clazz.server.server2serverDecryptToken<CookieSessionUpdate>(evil_encryptedCookieSessionUpdate, "CookieSessionUpdate"); // Will also validate evil_...
        if(cookieSessionUpdate.serverSessionClassId !== this.clazz.id) {
            throw new CommunicationError(`cookieSessionUpdate came from another service`)
        }

        const oldCookieSession = this.clazz.getFixedCookieSessionFromRequest(this.call.req!);
        if(!oldCookieSession) {
            throw new CommunicationError("Session not yet initialized (or timed out). Can only update an existing session."); // You must got he 'New session' -> needsCookieSession way again // We can only accept updates to existing ones, to prevent an attacker to install his stock session.
        }
        const newCookieSession = cookieSessionUpdate.newSession;
        if(oldCookieSession.id !== newCookieSession.id) {
            throw new CommunicationError("Cannot update the session: Existing session has a different id (may be timed out and recreated).");
        }
        if(oldCookieSession.version +1 !== newCookieSession.version) {
            // Error, but narrow down better error message:
            if(oldCookieSession.version >= newCookieSession.version) {
                if(oldCookieSession.bpSalt === newCookieSession.bpSalt) {
                    throw new CommunicationError("Cannot update the session: updateCookieSession method called twice with the same value / already up2date");
                }
                else {
                    throw new CommunicationError(`Cannot update the session: The version that your writes refer to, is outdated. Another remote method call has updated the session in the meanwhile. Try to better synchronize your calls on the client side.`); // Most likely situation
                }
            }
            throw new CommunicationError("Cannot update the session: Existing session has a different version (your call arrived to late, it was already modified by another).");
        }
        if(oldCookieSession.bpSalt !== newCookieSession.previousBpSalt) {
            throw new CommunicationError("Cannot update the session: Wrong bpSalt");
        }

        // Update the session:
        if(newCookieSession.commandDestruction) {
            await this.clazz.destroyExpressSession(this.call.req!, this.call.res!);

            // Do  "return this.getCookieSession(evil_alsoReturnNewSession)" manually, cause it does not detect the destroyed session:
            const question = this.clazz.server.server2serverDecryptToken(evil_alsoReturnNewSession, "GetCookieSession_question");
            return {
                token: this.clazz.server.server2serverEncryptToken({
                    question: question,
                    cookieSession: undefined
                }, "GetCookieSessionAnswerToken"),
                state: undefined
            }
        }
        else {
            this.clazz.updateAndSendReqSession(newCookieSession, this.call.req!, this.call.res!);
        }

        return this.getCookieSession(evil_alsoReturnNewSession); // will also validate evil_...
    }

    /**
     * Unsets the cookie, after the call has finished.
     * Till then, you might still see current values.
     * @protected
     */
    protected destroy() {
        (this as any as CookieSession).commandDestruction = true;
        //this.id = undefined // Don't unset. In a socket call, this session is first regularly committed to the http side, and then the the commandDestruction flag is evaluated and it's really destroyed.
    }

    /**
     * Generic method for both kinds of tokens (they're created the same way but are stored in different fields for clarity)
     * The token is stored in the session and a transfer token is returned which is BREACH shielded.
     * @param session The raw CookieSession. The version will be increased, if written to
     * @param csrfProtectionMode
     * @private
     */
    private static getOrCreateSecurityToken(session: SecurityRelevantSessionFields, csrfProtectionMode: "corsReadToken" | "csrfToken"): string {
        if (session.csrfProtectionMode !== undefined && session.csrfProtectionMode !== csrfProtectionMode) {
            throw new CommunicationError(`Session is already initialized with csrfProtectionMode=${session.csrfProtectionMode} but this request wants to use ${csrfProtectionMode}. Please make sure that all browser clients (for this session) use the same mode.`)
        }

        const tokensFieldName = csrfProtectionMode==="corsReadToken"?"corsReadTokens":"csrfTokens";

        let sessionWasModified = false;

        // initialize the session:
        if(session.csrfProtectionMode !== csrfProtectionMode) {
            session.csrfProtectionMode = csrfProtectionMode;
            sessionWasModified = true;
        }

        const tokens = session[tokensFieldName] = session[tokensFieldName] || {}; // initialize
        checkIfSecurityFieldsAreValid(session);

        const securityGroupId = this.securityGroup.id;
        if (tokens[securityGroupId] === undefined) {
            // Create a token:
            tokens[securityGroupId] = crypto.randomBytes(16).toString("hex");
            sessionWasModified = true;
        }

        if(sessionWasModified) {
            this.increaseCookieSessionVersion(session);
        }

        const token = tokens[securityGroupId];
        const rawToken = Buffer.from(token,"hex");
        return shieldTokenAgainstBREACH(rawToken);
    }

    /**
     * Don't override
     */
    static get securityGroup(): SecurityGroup {
        return new SecurityGroup(this.options, [this]); // TODO: remove this line when implemented
        return this.server.getSecurityGroupOfService(this)
    }

    /**
     * @returns resolved value from settings with default fallback
     * @see ServerSessionOptions#devDisableSecurity
     */
    static get isSecurityDisabled() {
        return this.options.devDisableSecurity !== undefined?this.options.devDisableSecurity:(process.env.NODE_ENV=="development")
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
        // Determine path tokens:
        const url = URL.parse(req.url);
        const relativePath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
        const pathTokens = relativePath.split("/");

        const reflectedMethod = isTypeInfoAvailable(this)?reflect(this).getMethod(methodName):undefined;

        const result = new class {
            methodArguments: unknown[] = []; // Params/arguments that will actually enter the method
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

        const convertAndAddParams = (params: unknown, source: ParameterSource) => {

            const addParamsArray = (params: unknown[]) => {
                function addValue(value: unknown) {
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
                        throw new CommunicationError(`Runtime typechecking of destructuring arguments is not yet supported`)
                    }
                    else {
                        addValue(this.autoConvertValueForParameter(value, listInsertionParameter, source));
                    }
                }
            }


            /**
             * Adds the paramsMap to the targetParams array into the appropriate slots and auto converts them.
             */
            const addParamsMap = (paramsMap: Record<string, unknown>) => {
                // Add meta parameters first (cause they are needed in the next loop):
                for(const name in paramsMap) {
                    const value = paramsMap[name];
                    if (metaParameterNames.has(name)) {
                        if (typeof value !== "string") {
                            throw new Error("Meta parameter value is not a string: " + value);
                        }
                        result.metaParams[name] = value;
                    }
                }

                for(const name in paramsMap) {
                    if(metaParameterNames.has(name)) {
                        continue // already handled
                    }

                    const value = paramsMap[name];

                    if(!reflectedMethod) {
                        throw new CommunicationError(`Cannot associate the named parameter: ${name} to the method cause runtime type information is not available.\n${ServerSession._diagnosis_HowToSetUpTheBuild()}`)
                    }

                    const parameter: ReflectedMethodParameter|undefined = reflectedMethod.getParameter(name);
                    if(!parameter) {
                        if(result.metaParams["shapeArguments"] === "true") {
                            continue;
                        }
                        throw new CommunicationError(`Method ${methodName} does not have a parameter named '${name}'. Hint: If you want to just ignore such non-matching parameter names, you can set the http header (or also a normal parameter) "shapeArguments" to true. Or you can control this via RemoteMethodOptions#shapeArguments.`)
                    }
                    if(parameter.isRest) {
                        throw new CommunicationError(`Cannot set ...${name} through named parameter`)
                    }
                    result.methodArguments[parameter.index] = this.autoConvertValueForParameter(value, parameter, source)
                }
            }

            if(params === undefined || params === null) {
                return;
            }

            if(_.isArray(params)) {
                addParamsArray(params);
            }
            else if(typeof params === "object") { // Named ?
                addParamsMap(params as Record<string, unknown>);
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
                throw new CommunicationError(`You should not send the sensitive csrfToken/corsReadToken in a query parameter (only with GET). Please send it in a header or in the body.`);
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
                throw new CommunicationError("multipart/form-data file uploads not yet implemented")
                //let bb = busboy({ headers: req.headers });
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
                            // Obtain trimExtraProperties like in the original logic:
                            const options = this.getRemoteMethodOptions(methodName);
                            const trimExtraProperties = options.shapeArguments !== undefined?options.shapeArguments:result.metaParams["shapeArguments"] === "true";

                            this.validateMethodArguments(methodName, result.methodArguments, trimExtraProperties);
                        }
                    } catch (e) {
                        // Give the User a better error hint for the common case that i.e. javascript's 'fetch' automatically set the content type to text/plain but JSON was meant.
                        if (e instanceof Error && diagnosis_looksLikeJSON(rawBodyText)) {
                            throw new CommunicationError(`${e.message}\nHINT: You have set the Content-Type to 'text/plain' but the body rather looks like 'application/json'.`)
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
                    throw new CommunicationError("Request body invalid. Consider explicitly specifying the content type")
                }
            }
            else {
                throw new CommunicationError(`Content-Type: '${contentType}' not supported`)
            }
        }
        else if (!_.isEqual(req.body, {})) { // non empty body ?
            throw new CommunicationError("Unhandled non-empty body. Please report this as a bug.")
        }

        return result;
    }

    /**
     * Throws a (good readable) CommunicationError if args does not match the parameters of reflectedMethod.
     * <p>
     * Internal / not part of the API (for now, may be later). Do not override
     * </p>
     * @param reflectedMethod
     * @param args
     */
    protected static validateMethodArguments(methodName: string, args: unknown[], trimExtraproperties: boolean) {
        const meta = this.getRemoteMethodMeta(methodName);
        const validationResult= trimExtraproperties?meta.arguments.validatePrune(args):meta.arguments.validateEquals(args);
        if(validationResult.success) {
            return;
        }

        const prefix = `Invalid argument(s) for method ${methodName}`;

        const errors = validationResult.errors;

        // Handle invalid number of arguments:
        if(errors.length == 1 && errors[0].path === "$input") {
            throw new CommunicationError(`${prefix}: invalid number of arguments`); // Hope that matches with the if condition
        }

        // Compose errors into readable messages:
        const readableErrors: string[] = errors.map(error => {
            // Replace $input[x] with <argument name>, if possible
            const improvedPath = error.path.replace(/^\$input\[([0-9]+)\]/,(orig, index: string) => {

                try {
                    const reflectedMethod = isTypeInfoAvailable(this)?reflect(this).getMethod(methodName):undefined;
                    if(reflectedMethod) {
                        return reflectedMethod.parameters[Number(index)].name;
                    }
                }
                catch (e) {

                }
                return orig;
            })

            return `${improvedPath}: expected ${error.expected} but got: ${diagnisis_shortenValue(error.value)}`
        })

        const separateLines = readableErrors.length > 1;
        throw new CommunicationError(`${prefix}:${separateLines ? "\n" : " "}${readableErrors.join("\n")}`);
    }


    /**
     * Security checks the method name and args.
     * <p>Internal. API may change</p>
     * @param evil_methodName
     * @param evil_args
     */
    protected validateCall(evil_methodName: string, evil_args: unknown[], trimExtraProperites: boolean) {
        const options = this.clazz.options;

        // types were only for the caller. We go back to "unknown" so must check again:
        const methodName = <unknown> evil_methodName;
        const args = <unknown> evil_args;

        // Check methodName:
        if(!methodName) {
            throw new CommunicationError(`methodName not set`)
        }
        if(typeof methodName !== "string") {
            throw new CommunicationError(`methodName is not a string`)
        }
        if((this as any as ObjectWithStringIndex)[methodName] === undefined) {
            throw new CommunicationError(`You are trying to call a remote method that does not exist or is not a function: '${methodName}' `)
        }
        // @ts-ignore
        const method = this[methodName];
        if(typeof method != "function") {
            throw new CommunicationError(`You are trying to call a remote method that does not exist or is not a function: '${methodName}' `) // Same message as above, to prevent information leak that a field was set.
        }

        // Check that args is an array:
        if(!args || args.constructor !== Array) {
            throw new CommunicationError("args is not an array")
        }

        this.clazz.checkIfMethodHasRemoteDecorator(methodName);
        const remoteMethodOptions = this.clazz.getRemoteMethodOptions(methodName);

        if(this.clazz.isSecurityDisabled) {
            return;
        }

        if(remoteMethodOptions.validateArguments !== false) {
            this.clazz.validateMethodArguments(methodName, args, trimExtraProperites);
        }
    }

    /**
     * Validates the result of a remote method call.
     * Also shapes it, if set by in the options.
     * <p>Internal. API may change</p>
     * @param result the awaited result
     * @param remoteMethodName
     * @protected
     */
    protected validateAndShapeResult(result: unknown, remoteMethodName: string) {
        if(this.clazz.isSecurityDisabled) {
            return;
        }

        // obtain reflectedMethod:
        if (!isTypeInfoAvailable(this)) {
            throw new Error(`No runtime type information available for class '${this.clazz.name}'. Please make sure, that it is enhanced with the restfuncs-transformer: ${ServerSession._diagnosis_HowToSetUpTheBuild()}`);
        }
        let reflectedClass = reflect(this);
        const reflectedMethod = reflectedClass.getMethod(remoteMethodName); // we could also use reflect(method) but this doesn't give use params for anonymous classes - strangely'
        // Check if full type info is available:
        if (!(reflectedMethod.class?.class && isTypeInfoAvailable(reflectedMethod.class.class))) { // not available for the actual declaring superclass ?
            throw new Error(`No runtime type information available for class '${reflectedMethod.class?.class?.name}' which declared the method '${remoteMethodName}'. Please make sure, that also that file is enhanced with the restfuncs-transformer: ${ServerSession._diagnosis_HowToSetUpTheBuild()}`);
        }

        let returnType = reflectedMethod.returnType;
        if(returnType.isPromise()) {
            returnType = returnType.typeParameters[0]; // de-reference it
        }

        // Bug workaround: Buffer causes a validation error:
        if(result instanceof Buffer) {
            // Obtain type (class) of parameter:
            const typeRef = (returnType as any)?.ref;
            if(typeRef === undefined) {
                throw new Error("Cannot obtain typeRef. This may be due to nasty unsupported API usage of typescript-rtti by restfuncs and the API has may be changed. Report this as a bug to the restfuncs devs and try to go back to a bit older (minor) version of 'typescript-rtti'.")
            }
            if(typeRef === Buffer) {
                return; // Skip validation of Buffer
            }
        }

        // Validate:
        const errors: Error[] = []

        const meta = this.clazz.getRemoteMethodMeta(remoteMethodName);
        const shouldShapeResult = this.clazz.getRemoteMethodOptions(remoteMethodName).shapeResult !== false;
        const validationResult = shouldShapeResult?meta.result.validatePrune(result):meta.result.validateEquals(result);
        if(validationResult.success) {
            return;
        }

        // *** Compose error message and throw it ***:

        const prefix = `${remoteMethodName} returned an invalid value`

        // Compose errors into readable messages:
        const readableErrors: string[] = validationResult.errors.map(error => {
            const improvedPath = error.path.replace(/^\$input/,"<result>")
            return `${improvedPath !== "<result>"?`${improvedPath}: `: ""}expected ${error.expected} but got: ${diagnisis_shortenValue(error.value)}`
        })

        const separateLines = readableErrors.length > 1;
        throw new CommunicationError(`${prefix}:${separateLines ? "\n" : " "}${readableErrors.join("\n")}`);
    }
    
    /**
     * Allows you to intercept calls, by overriding this method.
     * You have access to this.call.req, this.call.res as usual.
     * <p>
     *     Calls to Restfuncs internal control methods do not go though this method.
     * </p>
     */
    protected async doCall(remoteMethodName: string, args: unknown[]) {
        // @ts-ignore
        return await this[remoteMethodName](...args) // Call the method
    }

    /**
     * Browser CSRF protection:
     * Checks, that we can trust the request to be from an allowed origin, so that it can't make unallowed cross-site write operations.
     * <p>
     *     A breakdown of this method can be found in 'Security concept.md#csrf-protection'
     * </p>
     *
     * @param reqSecurityProps
     * @param enforcedCsrfProtectionMode Must be met by the request. Undefined = "preflight".
     * @param allowedOrigins from the options
     * @param cookieSession holds the tokens
     * @param remoteMethodName
     * @param diagnosis
     */
    private static checkIfRequestIsAllowedCrossSite(reqSecurityProps: SecurityPropertiesOfHttpRequest, enforcedCsrfProtectionMode: CSRFProtectionMode | undefined, allowedOrigins: AllowedOriginsOptions, cookieSession: Pick<SecurityRelevantSessionFields,"corsReadTokens" | "csrfTokens">, remoteMethodName: string, diagnosis: CIRIACS_Diagnosis): void {
        // note that this this called from 2 places: On the beginning of a request with enforcedCsrfProtectionMode like from the ServerSessionOptions. And on cookieSession value access where enforcedCsrfProtectionMode is set to the mode that's stored in the cookieSession.

        const errorHints: {priority: number, hint: string}[] = [];
        const addErrorHint = (hint: string, priority?: number) => errorHints.push({hint, priority: priority !== undefined?priority:100})
        /**
         * Indicate this to the client that is should fetch/re-fetch it to solve the problem
         */
        let aValidCorsReadTokenWouldBeHelpful = false;

        /**
         * returns the result as boolean. Collects the above variables.
         */
        const isAllowedInner = () => {
            const diagnosis_seeDocs = `${DOCS_READMEURL}#csrf-protection.`

            if(this.isSecurityDisabled) {
                return true;
            }

            // Fix / default some reqSecurityProps for convenience:
            if (reqSecurityProps.csrfToken && reqSecurityProps.csrfProtectionMode && reqSecurityProps.csrfProtectionMode !== "csrfToken") {
                throw new CommunicationError(`Illegal request parameters: csrfProtectionMode:'${reqSecurityProps.csrfProtectionMode}' and csrfToken is set.`)
            }
            if (reqSecurityProps.corsReadToken && reqSecurityProps.csrfProtectionMode && reqSecurityProps.csrfProtectionMode !== "corsReadToken") {
                throw new CommunicationError(`Illegal request parameters: csrfProtectionMode:'${reqSecurityProps.csrfProtectionMode}' and corsReadToken is set.`)
            }
            if (reqSecurityProps.corsReadToken && !reqSecurityProps.csrfProtectionMode) {
                throw new CommunicationError(`When sending a corsReadToken, you must also indicate that you want csrfProtectionMode='corsReadToken'. Please indicate that in every request. ${diagnosis_seeDocs}`)
            }
            if (reqSecurityProps.csrfToken) {
                reqSecurityProps.csrfProtectionMode = "csrfToken"; // Here it's clear from the beginning on, that the user wants this protection mode
            }


            const tokenValid = (tokenType: "corsReadToken" | "csrfToken") => {

                const reqToken = reqSecurityProps[tokenType];
                if (!reqToken) {
                    addErrorHint(`Please provide a ${tokenType} in the header / query- / body parameters. ${diagnosis_seeDocs}`);
                    return false;
                }

                const sessionTokens = tokenType == "corsReadToken" ? cookieSession.corsReadTokens : cookieSession.csrfTokens;
                if (sessionTokens === undefined) {
                    addErrorHint(`Session.${tokenType}s not yet initialized. Maybe the server restarted. Please properly fetch the token. ${diagnosis_seeDocs}`);
                    return false;
                }

                if (!sessionTokens[this.securityGroup.id]) {
                    addErrorHint(`You provided a ${tokenType}, but no ${tokenType} was stored in the session for the ServerSession class (or same security group), you are using. Maybe the server restarted or, the token, you presented, is for another ServerSession class. Please fetch the token again. ${diagnosis_seeDocs}`);
                    return false;
                }

                try {
                    if (crypto.timingSafeEqual(Buffer.from(sessionTokens[this.securityGroup.id], "hex"), shieldTokenAgainstBREACH_unwrap(reqToken))) { // sessionTokens[service.id] === reqToken ?
                        return true;
                    } else {
                        addErrorHint(`${tokenType} incorrect`);
                    }
                }
                catch (e) {
                    throw new CommunicationError(`Error validating ${tokenType}: ${(<Error>e)?.message}. Make sure it has the proper form.`, {cause: (e instanceof Error?e:undefined)});
                }

                return false;
            }

            // Check protection mode compatibility:
            if (enforcedCsrfProtectionMode !== undefined) {
                if ((reqSecurityProps.csrfProtectionMode || "preflight") !== enforcedCsrfProtectionMode) { // Client and server(/cookieSession) want different protection modes  ?
                    addErrorHint(
                        (diagnosis.isSessionAccess ? `The session was created with / is protected with csrfProtectionMode='${enforcedCsrfProtectionMode}'` : `The server requires ServerSessionOptions#csrfProtectionMode = '${enforcedCsrfProtectionMode}'`) +
                        (reqSecurityProps.csrfProtectionMode ? `, but your request wants csrfProtectionMode='${reqSecurityProps.csrfProtectionMode}'. ` : (enforcedCsrfProtectionMode === "csrfToken" ? `. Please provide a csrfToken in the header / query- / body parameters. ` : `, but your request did not specify/want a csrfProtectionMode. `)) +
                        `${diagnosis_seeDocs}`
                    );
                    return false;
                }
            }

            if (enforcedCsrfProtectionMode === "csrfToken") {
                if (reqSecurityProps.browserMightHaveSecurityIssuseWithCrossOriginRequests) {
                    // With a non secure browser, we can't trust a valid csrfToken token. Cause these could i.e. read out the contents of the main / index.html page cross-origin by script and extract the token.
                    addErrorHint(`You can't prove a valid csrfToken because your browser does not support CORS or might have security issues with cross-origin requests. Please use a more secure browser. Any modern Browser will do.`)
                    return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
                }
                return tokenValid("csrfToken"); // Strict check already here.
            }
            //Diagnosis:
            if (!reqSecurityProps.browserMightHaveSecurityIssuseWithCrossOriginRequests) {
                addErrorHint(`Lastly, but harder to implement: You could allow the request by showing a csrfToken. ${diagnosis_seeDocs}`, 10)
                addErrorHint(`And for development, you could enable ServerSessionOptions#devDisableSecurity or set NODE_ENV=development`, 8)
            }

            const diagnosis_oHints: string[] = []
            if (originIsAllowed({...reqSecurityProps, allowedOrigins}, diagnosis_oHints)) {
                return true
            }
            diagnosis_oHints.forEach(h => addErrorHint(h, 120));

            // The server side origin check failed but the request could still be legal:
            // In case of same-origin requests: Maybe our originAllowed assumption was false negative (because behind a reverse proxy) and the browser knows better.
            // Or maybe the browser allows non-credentialed requests to go through (which can't do any security harm)
            // Or maybe some browsers don't send an origin header (i.e. to protect privacy)

            if (reqSecurityProps.browserMightHaveSecurityIssuseWithCrossOriginRequests) {
                addErrorHint("Your browser does not support CORS or might have security issues with cross-origin requests. Please use a more secure browser. Any modern Browser will do.")
                return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
            }

            if (enforcedCsrfProtectionMode === "corsReadToken") {
                if (reqSecurityProps.readWasProven || tokenValid("corsReadToken")) {  // Read was proven ?
                    return true;
                }
                aValidCorsReadTokenWouldBeHelpful = true;
            }
            else {
                addErrorHint(`You could allow the request by showing a corsReadToken. ${diagnosis_seeDocs}`)
            }

            if (reqSecurityProps.couldBeSimpleRequest) { // Simple request (or a false positive non-simple request)
                // Simple requests have not been preflighted by the browser and could be cross-site with credentials (even ignoring same-site cookie)
                if (reqSecurityProps.httpMethod === "GET" && this.getRemoteMethodOptions(remoteMethodName).isSafe) {
                    return true // Exception is made for GET to a safe method. These don't write and the results can't be read (and for the false positives: if the browser thinks that it is not-simple, it will regard the CORS header and prevent reading)
                } else {
                    // Deny

                    // Add error hints:
                    if (diagnosis.http?.contentType == "application/x-www-form-urlencoded" || diagnosis.http?.contentType == "multipart/form-data") { // SURELY came from html form ?
                    } else if (reqSecurityProps.httpMethod === "GET" && reqSecurityProps.origin === undefined && diagnosis.http && _(diagnosis.http.acceptedResponseContentTypes).contains("text/html")) { // Top level navigation in web browser ?
                        addErrorHint(`GET requests to '${remoteMethodName}' from top level navigations (=having no origin)  are not allowed because '${remoteMethodName}' is not considered safe.`, 110);
                        addErrorHint(`If you want to allow '${remoteMethodName}', make sure it contains only read operations and mark it with @remote({isSafe: true}).`, 110)
                        if (this.diagnosis_methodWasDeclaredSafeAtAnyLevel(remoteMethodName)) {
                            addErrorHint(`NOTE: '${remoteMethodName}' was only flagged 'isSafe' in a parent class, but that flag it is missing on your *overridden* method. See JSDoc of @remote({isSafe: ...})`, 110)
                        }
                    } else if (reqSecurityProps.httpMethod === "GET" && reqSecurityProps.origin === undefined) { // Crafted http request (maybe from in web browser)?
                        addErrorHint(`Also when this is from a crafted http request (written by you), you may set the 'IsComplex' header to 'true' and this error will go away.`,110);
                    } else if (diagnosis.http?.contentType == "text/plain") { // MAYBE from html form
                        addErrorHint(`Also when this is from a crafted http request (and not a form), you may set the 'IsComplex' header to 'true' and this error will go away.`,110);
                    } else if (reqSecurityProps.httpMethod !== "GET" && reqSecurityProps.origin === undefined) { // Likely a non web browser http request (or very unlikely that a web browser will send these as simple request without origin)
                        addErrorHint(`You should specify a Content-Type header (to make it not count as a simple request).`, 110);
                    }

                    return false; // Deny
                }
            } else { // Surely a non-simple request ?
                // *** here we are only secured by the browser's preflight ! ***

                if (remoteMethodName === "getCorsReadToken") {
                    return true;
                }

                if (enforcedCsrfProtectionMode === undefined || enforcedCsrfProtectionMode === "preflight") {
                    return true; // Trust the browser that it would bail after a negative preflight
                }
            }

            return false;
        }

        if(!isAllowedInner()) {
            errorHints.sort((a, b) => b.priority - a.priority)
            throw new CommunicationError(`${diagnosis.isSessionAccess?`Session access is not allowed`:`Not allowed`}: ` + (errorHints.length > 1?`Please fix one of the following issues: ${errorHints.map(entry => `\n- ${entry.hint}`)}`:`${errorHints[0].hint || ""}`), {httpStatusCode: aValidCorsReadTokenWouldBeHelpful?480:403})
        }
    }


    /**
     * Wraps the session in a proxy that that checks {@link checkIfRequestIsAllowedCrossSite} on every access (with the session's csrfProtectionMode)
     * @param session
     * @param reqSecurityProperties
     * @param allowedOrigins
     * @param remoteMethodName
     * @param diagnosis
     */
    private static createGuardProxy(session: ServerSession & SecurityRelevantSessionFields, reqSecurityProperties: SecurityPropertiesOfHttpRequest, allowedOrigins: AllowedOriginsOptions, remoteMethodName: string, diagnosis: Omit<CIRIACS_Diagnosis,"isSessionAccess">) {

        const checkFieldAccess = (isRead: boolean) => {
            if(isRead && session.csrfProtectionMode === undefined) {
                //Can we allow this ? No, it would be a security risk if the attacker creates such a session and makes himself a login and then the valid client with with an explicit csrfProtectionMode never gets an error and actions performs with that foreign account.
            }

            this.checkIfRequestIsAllowedCrossSite(reqSecurityProperties, session.csrfProtectionMode, allowedOrigins, session, remoteMethodName, {... diagnosis, isSessionAccess: true})
        }

        return new Proxy(session, {
            get(target: ServerSession, p: keyof ServerSession | symbol, receiver: any): any {

                // Reject symbols (don't know what it means but we only want strings as property names):
                if (typeof p != "string") {
                    throw new CommunicationError(`Unhandled : ${String(p)}`)
                }

                // @ts-ignore
                if(p === "__isCsrfProtectedSessionProxy") { // Probe field ?
                    return true;
                }

                if (typeof target[p] === "function") {
                    return target[p]; // allow
                }

                // If you first wonder, why need to trigger the csrf check for read access: This read may get the userId and call makes WRITES to the DB with it afterwards.
                // Also we cant make an exception for field access to a user's new ServerSession's default fields. At first, this sounds like it could be allowed/unchecked. But imagine an existing session where the user is logged on. An attacker could leak information THAT the user is logged in. Or leak information from other fields (whether they're still on the default value or not)
                // Also there could be a read + deep modification.
                checkFieldAccess(false);

                return target[p];
            },
            set(target: ServerSession, p: keyof ServerSession | symbol, newValue: any, receiver: any): boolean {
                // Reject symbols (don't know what it means but we only want strings as property names):
                if (typeof p != "string") {
                    throw new CommunicationError(`Unhandled : ${String(p)}`)
                }

                checkFieldAccess(false);

                if(session.csrfProtectionMode === undefined && reqSecurityProperties.csrfProtectionMode) { // Session protection not yet initialized ?
                    // initialize how the client wants it:
                    const newFields: SecurityRelevantSessionFields = {
                        csrfProtectionMode: reqSecurityProperties.csrfProtectionMode || "preflight",
                        corsReadTokens: (reqSecurityProperties.csrfProtectionMode === "corsReadToken")?{}:undefined,
                        csrfTokens: (reqSecurityProperties.csrfProtectionMode === "csrfToken")?{}:undefined
                    }
                    checkIfSecurityFieldsAreValid(newFields);
                    _(session).extend(newFields)

                    checkFieldAccess(false); // Check access again. It might likely be the case that we don't have the corsRead token yet. So we don't let the following write pass. It's no security issue but it would be confusing behaviour, if the remote method failed in the middle of 2 session accesses. Breaks the testcase acutally. See restfuncs.test.ts -> Sessions#note1
                }

                // @ts-ignore
                target[p] = newValue;
                return true;
            },
            deleteProperty(target: ServerSession, p: string | symbol): boolean {
                checkFieldAccess(false);
                throw new Error("deleteProperty not implemented.");
            },
            has(target: ServerSession, p: string | symbol): boolean {
                //checkFieldAccess(true); // validateCall invokes this for reflections and we don't want to trigger an access check then but this could lead to an information leak ! TODO: do better
                return p in target;
            },
            ownKeys(target: ServerSession): ArrayLike<string | symbol> {
                checkFieldAccess(true);
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
    protected static parseQuery(query: string): {result: Record<string, unknown>|unknown[], containsStringValuesOnly: boolean} {
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
     * ... and is therefore allowed, if no error is thrown.
     * <p>You can override this as part of the Restfuncs API.</p>
     * @param methodName
     * @protected
     */
    protected static checkIfMethodHasRemoteDecorator(methodName: string) {
        let declaringClazz: typeof ServerSession = this;
        while(declaringClazz && !declaringClazz.prototype?.hasOwnProperty(methodName)) {
            declaringClazz = (declaringClazz.superClass as typeof ServerSession);
        }

        if(!declaringClazz) {
            throw new Error(`Method not found: ${methodName}`)
        }

        const result = declaringClazz.hasOwnProperty("remoteMethod2Options") &&  declaringClazz.remoteMethod2Options!.has(methodName)
        if (!result) {
            throw new CommunicationError(`Method: ${methodName} does not have a @remote() decorator.${diagnosis_tsConfig(declaringClazz)}`);

        }

        function diagnosis_tsConfig(clazz: object) {
            return (!clazz.hasOwnProperty("remoteMethod2Options"))?` Hint: No @remote() decorator was found at all in the ${clazz} class. Please make sure to enable "experimentalDecorators" in tsconfig.json.`:"";
        }

    }

    protected static getRemoteMethodMeta(methodName: string) {
        const declaringClass = this.getDeclaringClass(methodName);
        if(!(declaringClass as object).hasOwnProperty("getRemoteMethodsMeta")) {
            throw new Error(`Class ${declaringClass.name} was not transformed with the restfuncs-transformer. ${this._diagnosis_HowToSetUpTheBuild()}`)
        }
        const remoteMethodsMeta = declaringClass.getRemoteMethodsMeta();
        // Version check:
        if(remoteMethodsMeta.transformerVersion.major > COMPATIBLE_TRANSFORMER_MAJOR_VERSION) {
            throw new Error(`The class ${declaringClass.name} was compiled with an incompatible restfuncs-transformer version: ${remoteMethodsMeta.transformerVersion.major}`);
        }
        if(remoteMethodsMeta.transformerVersion.feature < REQUIRED_TRANSFORMER_FEATURE_VERSION) {
            throw new Error(`The class ${declaringClass.name} was compiled with a restfuncs-transformer version that is too old (in the minor version): ${remoteMethodsMeta.transformerVersion.major}.${remoteMethodsMeta.transformerVersion.feature}. Please npm install --safe-dev restfuncs-transformer`);
        }

        const result = remoteMethodsMeta.instanceMethods[methodName];

        // Plausibility check:
        if(result === undefined) {
            throw new Error(`Illegal state: method ${methodName} is not listed in instanceMethods. Please report this as a bug.`)
        }



        return result;
    }

    /**
     *
     * @param methodName
     * @protected
     * @returns the sub-most class that implemented the specified method.
     */
    protected static getDeclaringClass(methodName: string) {
        let declaringClazz: typeof ServerSession = this;
        while (declaringClazz && !declaringClazz.prototype?.hasOwnProperty(methodName)) {
            declaringClazz = (declaringClazz.superClass as typeof ServerSession);
        }

        if (!declaringClazz) {
            throw new Error(`Method not found: ${methodName}`)
        }
        return declaringClazz;
    }


    /**
     * You can override this as part of the Restfuncs API.
     * @see checkIfMethodHasRemoteDecorator
     * @param methodName
     * @returns The actual options where the defaults were resolved (see the jsdoc of each property) - except the last default because that's what the caller has to decide.
     */
    protected static getRemoteMethodOptions(methodName: string) : RemoteMethodOptions {
        let declaringClazz = this.getDeclaringClass(methodName);

        return declaringClazz.getRemoteMethodOptions_inner(methodName);
    }

    /**
     * You can override this as part of the Restfuncs API.
     * @see checkIfMethodHasRemoteDecorator
     * @param methodName
     * @returns
     */
    protected static getRemoteMethodOptions_inner(methodName: string) : RemoteMethodOptions {
        const parentResult: RemoteMethodOptions = (this.superClass as typeof ServerSession).getRemoteMethodOptions_inner?.(methodName) || {};

        const ownMethodOptions = (this.hasOwnProperty("remoteMethod2Options") &&  this.remoteMethod2Options!.get(methodName) ) || {} // from @remote decorator

        const ownDefaultOptions = (this.hasOwnProperty("defaultRemoteMethodOptions") && this.defaultRemoteMethodOptions) || {};
        if(ownDefaultOptions.isSafe) {
            throw new CommunicationError("Cannot define isSafe in the defaultRemoteMethodOptions, because this is a statement about each method's individual implementation");
        }


        return {
            isSafe: ownMethodOptions.isSafe,
            validateArguments: (ownMethodOptions.validateArguments !== undefined)?ownMethodOptions.validateArguments: ownDefaultOptions.validateArguments,
            validateResult: (ownMethodOptions.validateResult !== undefined)?ownMethodOptions.validateResult: ownDefaultOptions.validateResult,
            shapeResult: (ownMethodOptions.shapeResult !== undefined)?ownMethodOptions.shapeResult: ownDefaultOptions.shapeResult,
            shapeArguments: (ownMethodOptions.shapeArguments !== undefined)?ownMethodOptions.shapeArguments : (parentResult.shapeArguments !== undefined?parentResult.shapeArguments : ownDefaultOptions.shapeArguments),
            apiBrowserOptions: {
                needsAuthorization: (ownMethodOptions.apiBrowserOptions?.needsAuthorization !== undefined)?ownMethodOptions.apiBrowserOptions.needsAuthorization : (parentResult.apiBrowserOptions?.needsAuthorization !== undefined?parentResult.apiBrowserOptions.needsAuthorization : ownDefaultOptions.apiBrowserOptions?.needsAuthorization)
            }
        }
    }

    /**
     * You can override this as part of the API
     * @param target Either the instance or the class (as you can call instance + static methods -> static methods will come in the future may be)
     * @param methodName
     */
    protected static hasMethod(target: ServerSession | ClassOf<ServerSession>, methodName: string) {
        // @ts-ignore
        return target[methodName] && (typeof target[methodName] === "function");
    }

    /**
     * Retrieves, which method should be picked. I.e GET user -> getUser
     * <p>
     * You can override this as part of the API.
     * </p>
     * @param httpMethod
     * @param target Either the instance or the class (as you can call instance + static methods -> static methods will come in the future may be)
     * @param path the path portion that should represents the method name. No "/"s contained. I.e. "user" (meaning getUser or user)
     */
    protected static getMethodNameForCall(httpMethod: RegularHttpMethod, target: ServerSession | ClassOf<ServerSession>, path: string): string | undefined {
        if(path === "") {
            path = "index";
        }

        if (this.hasMethod(target, path)) { // Direct hit
            return path; // We are done and don't lose performance on other checks
        }

        // check: GET user -> getUser
        {
            const candidate = `${httpMethod.toLowerCase()}${Camelize(path)}`;
            if (this.hasMethod(target, candidate)) {
                return candidate;
            }
        }


        if (httpMethod === "PUT") {
            // check: PUT user -> updateUser
            {
                const candidate = `update${Camelize(path)}`;
                if (this.hasMethod(target, candidate)) {
                    return candidate;
                }
            }

            // check: PUT user -> setUser
            {
                const candidate = `set${Camelize(path)}`;
                if (this.hasMethod(target, candidate)) {
                    return candidate;
                }
            }
        }

        return undefined;
    }

    /**
     * @see #autoConvertValueForParameter_fromString
     * @see #autoConvertValueForParameter_fromJson
     */
    protected static autoConvertValueForParameter(value: unknown, parameter: ReflectedMethodParameter, source: ParameterSource): unknown {
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

    /**
     * Internal
     * @protected
     */
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
     * <p>You can override this as part of the API</p>
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    protected static autoConvertValueForParameter_fromString(value: string, parameter: ReflectedMethodParameter): unknown {
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
                return this.STRING_TO_BOOL_MAP[value];
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
            throw new CommunicationError(`Error converting value ${value} to parameter ${parameter.name}: ${e instanceof Error && e.message}`) // Wrap this in a CommunicationError cause we probably don't need to reveal the stacktrace here / keep the message simple
        }
    }

    /**
     * Fixes values that were passed in the request body (json) to the actual needed parameter type.
     *
     * Currently this is only for Date objects, since json lacks of representing these.
     * Other values (i.e. parameter needs Number but value is a string) will be left untouched, so they will produce the right error message at the later validity/security checking stage.
     *
     * <p>You can override this as part of the API</p>
     * @param value
     * @param parameter The parameter where this will be inserted into
     * @returns
     */
    protected static autoConvertValueForParameter_fromJson(value: unknown, parameter: ReflectedMethodParameter): unknown {
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
            throw new CommunicationError(`Error converting value ${diagnisis_shortenValue(value)} to parameter ${parameter.name}: ${e instanceof Error && e.message}`) // Wrap this in a CommunicationError cause we probably don't need to reveal the stacktrace here / keep the message simple
        }
    }

    /**
     * Lists (potentially) callable methods
     * Warning: Not part of the API ! Unlisting a method does not prevent it from beeing called !
     */
    static listCallableMethods() {

        const reflectedClass = reflect(this);
        return reflectedClass.methodNames.map(methodName => reflectedClass.getMethod(methodName)).filter(reflectedMethod => {
            if ((ServerSession.prototype as any as ObjectWithStringIndex)[reflectedMethod.name] !== undefined || {}[reflectedMethod.name] !== undefined) { // property exists in an empty service ?
                return false;
            }

            try {
                throw new Error("Not implemented") // TODO: check for @remote decorator
            }
            catch (e) {
            }
            return false;
        })
    }

    /**
     * TODO: Remove method and dependants if not needed
     */
    static mayNeedFileUploadSupport() {
        // Check if this service has methods that accept buffer

        const someBuffer = Buffer.alloc(0);
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

    static _diagnosis_HowToSetUpTheBuild() {
        return `Please see ${DOCS_READMEURL}#setting-up-the-build-here-it-gets-a-bit-nasty- .`
    }


    /**
     * Internal. See {@link ServerSessionOptions#logErrors} for a better hook.
     * @param error
     * @param req For retrieving info for logging
     */
    static logAndConcealError(error: Error, context?: {req?: Request, socketConnection?: ServerSocketConnection}) {
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
                this.options.logErrors(logMessage, context)
            }
            else {
                console.error(logMessage);
            }
        }

        // ** Cut off the parts of errorExt that should not be exposed and add some description *** :

        const DIAGNOSIS_SHOWFULLERRORS="If you want to see full errors on the client (development), set exposeErrors=true in the ServerSessionOptions."
        if(this.options.exposeErrors === true || this.isSecurityDisabled) {
            return errorExt;
        }

        let definitelyIncludedProps: Record<string, unknown> = {};
        if(isCommunicationError(error) && error.constructor !== CommunicationError) { // A (special) SUB-class of CommunicationError ? I.e. think of a custom NotLoggedInError
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
                stack: isCommunicationError(error)?undefined:`Stack hidden.${errorId?` See [${errorId}] in the server log.`:""} ${DIAGNOSIS_SHOWFULLERRORS}`,
                ...definitelyIncludedProps,
            };
        }
        else if( (this.options.exposeErrors === "RestErrorsOnly" || this.options.exposeErrors === undefined) && isCommunicationError(error)) {
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
    private static logAndGetErrorLineForPasteIntoStreams(error: Error, req: Request) {

        // TODO: if(this.isSecurityDisabled) { return full message }

        if(this.options.logErrors) {
            fixErrorStack(error)
            const errorExt: ErrorWithExtendedInfo = cloneError(error);

            const errorId = crypto.randomBytes(6).toString("hex");
            const logMessage = `${errorId?`[${errorId}]: `:""}${errorToString(errorExt)}`;

            if(typeof this.options.logErrors === "function") {
                this.options.logErrors(logMessage, {req})
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
     * Helper, to access static members from a non-static context.
     * <p>
     * In order to make your special static subclass members available, you must help typescript a bit by redefining the <code>classType</code> field with the follwing line:
     * </p>
     * <pre><code>
     *     classType!: typeof YOUR-SERVERSESSION-SUBCLASS;
     * </code></pre>
     */
    get clazz(): this["classType"] {
        // @ts-ignore
        return this.constructor
    }

    static get superClass(): typeof Object | typeof ServerSession {
        return Object.getPrototypeOf(this);
    }

    /**
     * Returns an id for this ServerSession.
     *
     * It's not checked for uniqueness.
     */
    private static generateId(): string {
        const className = this.name
        if(className && className !== "Object") {
            return className;
        }

        const generateIdFromContent = (sessionPrototype: object): string | undefined => {
            // generate an id of the first function names that are found.
            const MAX_LENGTH = 40;
            let result = "Obj";
            for (const k of Object.getOwnPropertyNames(sessionPrototype)) {
                // @ts-ignore
                if (typeof k === "string" && typeof sessionPrototype[k] == "function") {
                    result += "_" + k;
                    if (result.length >= MAX_LENGTH) {
                        return result.substring(0, MAX_LENGTH);
                    }
                }
            }

            // not enough info found ? I.e. the object was enhanced during typescript-rtti compile
            const prototype = Object.getPrototypeOf(sessionPrototype);
            if (prototype) {
                return generateIdFromContent(prototype); // Take the prototype
            }
        }

        let result = generateIdFromContent(this.prototype);
        if(!result) {
            throw new Error("Could not generate an id for your ServerSession subclass. Please set the id field.");
        }
        return result;
    }

    /**
     * Internal (don't override)
     */
    protected static ensureSessionHandlerInstalled(req: Request) {
        if(!req.session) {
            if(this.server.serverOptions.installSessionHandler === false) {
                throw new CommunicationError("Can't access to the (cookie-) session. No session handler was installed.")
            }
            throw new CommunicationError("Can't access to the (cookie-) session. No session handler was installed. Please use `const app = restfuncsExpress();` as a drop-in replacement for express. Or install your own (advanced).")
        }
    }

    private static diagnosis_methodWasDeclaredSafeAtAnyLevel(methodName: string): boolean {
        if(this.getRemoteMethodOptions(methodName)?.isSafe) {
            return true
        }
        return (this.superClass as typeof ServerSession).diagnosis_methodWasDeclaredSafeAtAnyLevel?.(methodName) || false;
    }
}

/**
 *
 * Options for your remote method.
 * <p>
 * For setting defaults on class level, see {@link ServerSession#defaultRemoteMethodOptions}
 * </p>
 */
export type RemoteMethodOptions = {
    /**
     * Indicates, that this method is [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), meaning that you are sure, it essentially performs only *read* operations.
     *
     * This flag is needed to allow for some cases where cross site security can't be checked otherwise. i.e:
     *   - A remote method that serves a html page so it should be accessible by top level navigation (i.e from a bookmark or an email link) as these don't send an origin header.
     *   - Remote methods that serve an image publicly to all origins.
     *
     * <p>
     * Default: false (you can't set defaults on class / parent level, you have to mark it actually, where the implementation is)
     * </p>
     */
    isSafe?: boolean

    /**
     * Validates, that the arguments have the proper type at runtime. The remote method's class has to be compiled with the restfuncs-transformer therefore.
     * <p>
     * Note: If you want to turn it off during development, rather use {@link ServerSessionOptions#devDisableSecurity} / NODE_ENV=development.
     * </p>
     * <p>
     * Default: Value from <b>this class</b>'s {@link #defaultRemoteMethodOptions} || <b>true</b>
     * </p>
     */
    validateArguments?: boolean

    /**
     * Trims away any extra properties and arguments that are not allowed otherwise.
     * <br/>
     * Example:
     * <pre><code>
     *     type User {
     *         name: string
     *     }
     *
     *     @remote({shapeArguments: true})
     *     myRemoteMethod(param1: User) {
     *         console.log(param1); // Outputs {name: "Pauline"}
     *     }
     *
     *     // On the client:
     *     // @ts-ignore (pretend that typescript does not complain already)
     *     myClient.myRemoteMethod({name: "Pauline", someExtraProperty: "xyz"}, "someExtraArgument"); // this call will pass.
     * </code></pre>
     *
     * Default: <br/>
     * Value from <b>super method</b>'s @remote options || <br/>
     * value from <b>this class</b>'s {@link #defaultRemoteMethodOptions} || <br/>
     * value from <b>super class</b>'s {@link #defaultRemoteMethodOptions} || <br/>
     * value from the <b>client</b>'s "shapeArguments" http header (<b>the restfuncs-client always enables this</b>) || <br/>
     * <b>false</b>
     *
     * <p>
     * <i>Note: shapeArguments doesn't work / make sense if you disabled {@link #validateArguments}.</p>
     * </p>
     */
    shapeArguments?: boolean

    /**
     * Performs a check at runtime, to ensure, that the returned value matches the type that is declared by the method (explicitly or implicitly).
     * <i>This prevents values that were formed somehow illegally: i.e. with the help of ts-ignore, castings, non-ts code, attached extra properties from libraries, ...</i>
     *
     * <p>
     *     Example:
     * </p>
     * <pre>
     *  @remote({validateResult: true})
     *  shouldReturnString(): string { // return type declared explicitly here
     *      // @ts-ignore
     *      return 123 // will fail
     *  }
     * </pre>
     *
     * <p>
     * Default: Value from <b>this class</b>'s {@link #defaultRemoteMethodOptions} || <b>true</b>
     * </p>
     */
    validateResult?: boolean

    /**
     * Like {@link #shapeArguments}, but for the result.
     * <p>
     * Default: Value from <b>this class</b>'s {@link #defaultRemoteMethodOptions} || <b>true</b>
     * </p>
     *
     * <p>
     * <i>Note: shapeResult doesn't work / make sense if you disable {@link #validateResult}.</p>
     * </p>
     */
    shapeResult?: boolean

    apiBrowserOptions?: {
        /**
         * Indicates this to the viewer by showing a lock symbol.
         * <p>
         * Default: Value from <b>actual method</b>'s @remote options || value from <b>super method</b>'s @remote options || <b>...</b> || value from <b>this class</b>'s {@link #defaultRemoteMethodOptions} || value from <b>super class</b>'s {@link #defaultRemoteMethodOptions} || <b>...</b> || <b>false</b>
         * </p>
         */
        needsAuthorization?: boolean
    }
}

/**
 * Allows this method to be called from the outside via http / websockets
 * @param options
 */
export function remote(options?: RemoteMethodOptions) {
    return function (target: ServerSession, methodName: string, descriptor: PropertyDescriptor) {
        // TODO: handle static methods (if we choose to support them)
        const clazz = target.clazz;
        if(!Object.getOwnPropertyDescriptor(clazz,"remoteMethod2Options")?.value) { // clazz does not have it's OWN .remoteMethod2Options initialized yet ?
            // @ts-ignore we want the field to stay protected
            clazz.remoteMethod2Options = new Map();
        }

        // @ts-ignore we want the field to stay protected
        clazz.remoteMethod2Options!.set(methodName, options || {});
    };
}

/**
 *
 * @param params: pre-computed origin and destination
 * @param errorHints Error messages will be added here
 * @return if origin and destination are allowed by the "allowedOrigins" option
 */
export function originIsAllowed(params: { origin?: string, destination?: string, allowedOrigins: AllowedOriginsOptions }, errorHints?: string[]): boolean {
    function isSameOrigin() {
        return params.destination !== undefined && params.origin !== undefined && (params.origin === params.destination);
    }

    if (params.allowedOrigins === "all") {
        return true;
    }


    if (typeof params.allowedOrigins === "function") {
        if (params.allowedOrigins(params.origin)) {
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
        // errorHints.push(`it seems like your server is behind a reverse proxy and therefore the server side same-origin check failed. If this is the case, you might want to add ${x-forwarded-by header} to ServerSessionOptions.allowedOrigins`)
    }

    errorHints?.push(`Request is not allowed from ${params.origin || "<unknown / no headers present>"} to ${params.destination}. See the allowedOrigins setting in the RestfuncsOptions. Also if you app server is behind a reverse proxy and you think the resolved proto/host/port of '${params.destination}' is incorrect, add the correct one (=what the user sees in the address bar) to ServerSessionOptions#allowedOrigins.`)

    return false;
}



/**
 * @see ServerSession#checkIfRequestIsAllowedCrossSite
 */
type CIRIACS_Diagnosis = { http?: { acceptedResponseContentTypes: string[], contentType?: string }, isSessionAccess: boolean };

/**
 * Checks that session is in a valid state (security relevant fields)
 *
 * Will be called on each write to security relevant fields
 * @param session
 */
function checkIfSecurityFieldsAreValid(session: SecurityRelevantSessionFields) {
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
