import 'reflect-metadata' // Must import
import express, {Router} from "express";
import session from "express-session";
import {cloneError, enhanceViaProxyDuringCall} from "./Util";
import http from "node:http";
import crypto from "node:crypto";
import {reflect, ReflectedMethod} from "typescript-rtti";
import {parse as brilloutJsonParse} from "@brillout/json-serializer/parse"
import {stringify as brilloutJsonStringify} from "@brillout/json-serializer/stringify"
import {isTypeInfoAvailable, RestService} from "./RestService";
import _ from "underscore";
export {RestService} from "./RestService";

const PROTOCOL_VERSION = "1.1" // ProtocolVersion.FeatureVersion

export type RestfuncsOptions = {
    /**
     * Only for standalone server
     */
    path?: string

    /**
     * Enable checking your func's arguments at runtime (shielding).
     *
     * To make it work, See https://github.com/bogeeee/restfuncs#runtime-arguments-typechecking-shielding-against-evil-input
     * See also the security notes there.
     *
     * When undefined, arguments typechecking will be tried but a warning is issued when not possible. It's recommended to explicitly enable this.
     */
    checkArguments?: boolean

    /**
     * Controls which methods can be called via http GET
     *
     * true/undefined (default): Only methods, starting with 'get', are allowed. I.e. getUser
     * false: No methods allowed
     * "all": All methods allowed (may be useful during development)
     *
     * SECURITY WARNING:
     * Those allowed methods can be triggered cross site, even in the context of the logged on user!
     * Make sure these methods are [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), i.e., perform read-only operations only.
     */
    allowGET?: true|false|"all"
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
            throw new Error("Invalid argument");
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
            throw new Error("Invalid argument");
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
                throw new Error(`Unhandled : ${String(p)}`);
            }

            if (target[p] === undefined) {
                return sessionPrototype[p];
            }
            return target[p];
        },
        set(target: Record<string, any>, p: string | symbol, newValue: any, receiver: any): boolean {
            // Reject symbols (don't know what it means but we only want strings as property names):
            if (typeof p != "string") {
                throw new Error(`Unhandled : ${String(p)}`);
            }

            if (newValue === undefined && sessionPrototype[p] !== undefined) { // Setting a value that exists on the prototype to undefined ?
                throw new Error(`Cannot set session.${p} to undefined. Please set it to null instead.`); // We can't allow that because the next get would return the initial value (from the prototype) and that's not an expected behaviour.
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
    const restService = RestService.initializeRestService(restServiceObj, options);


    const router = express.Router();

    router.use(express.json({limit: Number.MAX_VALUE, strict: true, inflate: false})) // parse old style application/json and make it available in req.body (in further handlers) TODO: When used with authentication, parse after auth to make it safer
    router.use(express.raw({limit: Number.MAX_VALUE, type: ["application/brillout-json"], inflate: false})) // parse application/brillout-json and make it available in req.body
    router.use(async (req, resp, next) => {
        try {
            // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
            resp.header("Expires","-1");
            resp.header("Pragma", "no-cache");

            resp.header("restfuncs-protocol",  PROTOCOL_VERSION); // Let older clients know when the interface changed

            // Determine method name:
            const methodName =  req.path.replace(/^\//, ""); // Remove trailing /
            if(!methodName) {
                throw new Error(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`);
            }

            let namedArgs: Record<string, any> = {};
            let args: any[] = [];
            // Parse req.body into args:
            const contentType = req.header("Content-Type");
            if(contentType == "application/json") { // Application/json
                args = req.body; // Args was already parsed to json by the express.json handler
            }
            else if(contentType == "application/brillout-json") {
                if(!(req.body && req.body instanceof Buffer)) {
                    throw new Error("req.body is no Buffer")
                }
                // @ts-ignore
                args = brilloutJsonParse(req.body.toString("utf8"));
            }
            else if (!_.isEqual(req.body, {})) { // non empty body ?
                throw new Error("You must set the Content-type header to application/json or application/brillout-json");
            }

            // Make sure that args is an array:
            if(!args || args.constructor !== Array) {
                args = [];
            }

            let session = null;
            // @ts-ignore
            const reqSession = req.session as Record<string,any>|undefined;
            if(reqSession !== undefined) { // Express runs a session handler ?
                session = createProxyWithPrototype(reqSession, restService._sessionPrototype!); // Create the this.session object which is a proxy that writes/reads to req.session but shows service.session's initial values. This way we can comply with the sessions's saveUninitialized=true / data protection friendlyness
            }

            let result = await restService.validateAndDoCall(req.method, methodName, args, {req, resp, session}, options);

            // Send result:
            if(req.header(("Accept")) == "application/brillout-json") { // Client requested the better json ?
                resp.send(brilloutJsonStringify(result));
            }
            else { // Send normal json (Old 0.x clients)
                result = result!==undefined?result:null; // Json does not support undefined
                resp.json(result);
            }
        }
        catch (e) {
            resp.status(500);
            if(e instanceof Error) {
                resp.json(cloneError(e));
            }
            else {
                resp.json(e);
            }
        }
    });

    return router;
}

