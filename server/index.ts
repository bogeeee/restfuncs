import 'reflect-metadata' // Must import
import express, {raw, Router, Request} from "express";
import session from "express-session";
import {cloneError, ERROR_PROPERTIES, errorToHtml, errorToString, ErrorWithExtendedInfo, fixErrorStack} from "./Util";
import http from "node:http";
import crypto from "node:crypto";
import {reflect, ReflectedMethod, ReflectedMethodParameter} from "typescript-rtti";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify"
import {checkParameterTypes, isTypeInfoAvailable, ParameterSource, RestService} from "./RestService";
import _ from "underscore";
import URL from "url"
import busboy from "busboy";

export {RestService} from "./RestService";

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
     * Web browser security: Which origins are allowed to make calls ?
     *
     * These origins will share the credentials (cookies, basic auth, ...) and therefore the same session !
     *
     * Change this option if you:
     *  - Host the backend and frontend on different (sub-) domains.
     *  - Provide authentication methods to other web applications.
     *  - Consume authentication responses from 3rd party authentication providers. I.e. form- posted SAML responses.
     *  - Provide service methods to other web applications.
     *  - Have a reverse proxy in front of this web app and the same-origin check fails for legacy *simple* requests (i.e. form posts). Alternatively check the trust proxy settings: http://expressjs.com/en/4x/api.html#app.settings.table
     *
     * Values:
     * - undefined (default): Same-origin only
     * - string[]: List the allowed origins: http[s]://host[:port]. Same-origin is always implicitly allowed
     * - "all": No restrictions
     * - function: A function (origin, destination) that returns true if it should be allowed. Args are in for form: http[s]://host[:port]
     *
     */
    allowedOrigins?: "all" | string[] | ( (origin?: string, destination?: string) => boolean )

    /**
     * Whether methods can be called via http GET
     *
     * "all": All methods allowed (may be useful during development)
     * true (default): Only methods, starting with 'get', are allowed. I.e. getUser
     * false: No methods allowed
     *
     * SECURITY WARNING:
     * Those allowed methods can be triggered cross site, even in the context of the logged on user!
     * Make sure these methods are [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), i.e., perform read-only operations only.
     */
    allowGET?: true|false|"all"


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
        function sendResult(result: any) {
            acceptedResponseContentTypes.find((accept) => { // Iterate until we have handled it
                if (accept == "application/brillout-json") { // The better json ?
                    resp.send(brilloutJsonStringify(result));
                }
                else if(accept == "application/json") {
                    result = result!==undefined?result:null; // Json does not support undefined
                    resp.json(result);
                }
                else {
                    return false; // not handled ?
                }
                return true; // it was handled
            });
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

            const originAllowed = originIsAllowed(req, options);
            const diagnosis_originNotAllowedMessage = () => `Request is not allowed from ${getOrigin(req) || "<unknown / no headers present>"} to ${getDestination(req)}. See the allowedOrigins setting in the RestfuncsOptions. \nAlso if you app server is behind a reverse proxy and you think the resolved proto/host/port of '${getDestination(req)}' is incorrect, check the trust proxy settings: http://expressjs.com/en/4x/api.html#app.settings.table`;
            // Check the origin of preflights:
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
                    throw new RestError(diagnosis_originNotAllowedMessage(), {httpStatusCode: 204});
                }

                resp.end();
                return;
            }

            if(originAllowed) {
                // A cross-site request (after successfull preflight) needs to see those headers AGAIN:
                resp.header("Access-Control-Allow-Origin", getOrigin(req));
                resp.header("Access-Control-Allow-Credentials", "true")
            }
            else { // Not allowed ?
                if (isSimpleRequest(req)) {
                    // Simple requests have not been preflighted by the browser and could be cross-site (even ignoring same-site cookie)

                    // Special error message(s):
                    const [contentType] = parseContentTypeHeader(req.header("Content-Type"));
                    if (contentType == "application/x-www-form-urlencoded" || contentType == "multipart/form-data") { // SURELY came from html form ?
                    } else { // MAYBE from html for (less often used enctype="text/plain" or other browser's implementations)
                        throw new RestError(`${diagnosis_originNotAllowedMessage()}. \nAlso if this request did not come from a (non-CORS-regarding) "simple" form post, you may flag this by setting the 'IsComplex' header to 'true' and this error will go away.`);
                    }

                    throw new RestError(`${diagnosis_originNotAllowedMessage()}`);
                }
                else { // Complex request ?
                    // The browser has made its preflight and regards the (missing) Access-Control-* settings itsself. We don't need to explicitly block those requests.
                    // Maybe our originAllowed assumption was false negative (because behind a reverse proxy) and the browser knows better.
                    // Or maybe the browser allows non-credentialed requests to go through (which can't do any security harm)
                }
            }


            // retrieve method name:
            const fixedPath =  req.path.replace(/^\//, ""); // Path, relative to baseurl, with leading / removed
            let methodNameFromPath = fixedPath.split("/")[0];
            if(!methodNameFromPath) {
                throw new RestError(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`)
            }
            const methodName = restService.getMethodNameForCall(req.method, methodNameFromPath);
            if(!methodName) {
                throw new RestError(`No method candidate found for ${req.method} + ${methodNameFromPath}.`)
            }

            const collectedParams = collectParamsFromRequest(restService, methodName, req, enableMultipartFileUploads);

            let session = null;
            // @ts-ignore
            const reqSession = req.session as Record<string,any>|undefined;
            if(reqSession !== undefined) { // Express runs a session handler ?
                session = createProxyWithPrototype(reqSession, restService._sessionPrototype!); // Create the this.session object which is a proxy that writes/reads to req.session but shows service.session's initial values. This way we can comply with the sessions's saveUninitialized=true / data protection friendlyness
            }

            let result = await restService.validateAndDoCall(req.method, methodName, collectedParams, {req, resp, session}, options);
            sendResult(result);
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
                        resp.contentType(`${accept}; charset=utf-8`)
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

const FAST_JSON_DETECTOR_REGEXP = /^([0-9\[{]|-[0-9]|true|false|null)/;
export function diagnosis_looksLikeJSON(value : string) {
    return FAST_JSON_DETECTOR_REGEXP.test(value);
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
 * Return If req might be a **simple** request.
 * https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests
 *
 * Not all headers are checked, so rather returns true / triggers security alarm.
 *
 * @param req
 */
function isSimpleRequest(req: Request) {
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