import express, {Request, Response, Router} from "express";
import session from "express-session";
import {cloneError, enhanceViaProxyDuringCall} from "./Util";
import http from "node:http";
import crypto from "node:crypto";


export type RestifyOptions = {
    /**
     * Only for standalone server
     */
    path?: string
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
export function restify(service: object | RESTService, port: number, options?: RestifyOptions) : http.Server;
/**
 * Creates an express router/middleware that makes service's member functions callable via REST.
 * Usage:
 *     app.use("/myAPI", restify( myService, { ...options});
 *
 * Side effects: The service.req/resp/session fields will be set to null
 * @param service
 * @return
 */
export function restify(service: object | RESTService, options?: RestifyOptions): Router;
export function restify(service: object | RESTService, arg1: any, arg2?: any): any {

    if(typeof(arg1) == "number") { // standalone ?
        const port = arg1;
        const options:RestifyOptions = arg2 || {};

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

        app.use(createRESTFuncsRouter(service, options));
        return app.listen(port);
    }
    else { // Express router
        const options:RestifyOptions = arg1 || {};

        if(typeof (options) !== "object") {
            throw new Error("Invalid argument");
        }

        return createRESTFuncsRouter(service, options);
    }
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
function createRESTFuncsRouter(service: object | RESTService, options: RestifyOptions): Router {
    const restService = service as RESTService; // To get rid of all the type errors we assume to have a RESTService

    // @ts-ignore
    const sessionPrototype = restService.session || {}; // The user has maybe has some initialization code for his session: {counter:0}  - so we want to make that convenient

    // Safety: Any non-null value for these may be confusing when (illegally) accessed from the outside.
    // @ts-ignore
    restService.req = null; restService.resp = null; restService.session = null;

    const router = express.Router();

    router.use(express.json({limit: Number.MAX_VALUE, strict: true, inflate: false})) // parse application/json. TODO: When used with authentication, parse after auth to make it safer

    router.use(async (req, resp, next) => {
        try {
            const methodName =  req.path.replace(/^\//, ""); // Remove trailing /

            // Parameter checks:
            if(!methodName) {
                throw new Error(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`);
            }
            if(new (class extends RESTService{})()[methodName] !== undefined || {}[methodName] !== undefined) { // property exists in an empty service ?
                throw new Error(`You are trying to call a remote method that is a reserved name: ${methodName}`);
            }
            if(restService[methodName] === undefined) {
                throw new Error(`You are trying to call a remote method that does not exist: ${methodName}`);
            }
            const method = restService[methodName];
            if(typeof method != "function") {
                throw new Error(`${methodName} is not a function`);
            }

            const args = req.body;

            // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
            resp.header("Expires","-1");
            resp.header("Pragma", "no-cache");

            let session = null;
            // @ts-ignore
            const reqSession = req.session as Record<string,any>|undefined;
            if(reqSession !== undefined) { // Express runs a session handler ?
                session = createProxyWithPrototype(reqSession, sessionPrototype); // Create the this.session object which is a proxy that writes/reads to req.session but shows service.session's initial values. This way we can comply with the sessions's saveUninitialized=true / data protection friendlyness
            }

            let result;
            // @ts-ignore
            await enhanceViaProxyDuringCall(restService, {req, resp, session}, async (service) => { // make .req and .resp safely available during call
                result = await method.apply(service, args); // Call method
            }, methodName);


            // Send result:
            result = result!==undefined?result:null; // Json does not support undefined
            resp.json(result);
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

/**
 * Service base class. Extend it and use {@see restify} on it.
 */
export class RESTService {
    [index: string]: any

    /**
     * The currently running (express) request.
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected readonly req!: Request = null;

    /**
     * Response for the currently running (express) request. You can modify any header fields as you like
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected readonly resp!: Response = null;


    /**
     * The browser/client session (for the currently running request). You can add any user defined content to it.
     * What you set as initial value here will also be the initial value of EVERY new session. Note that this initial session is not deeply cloned.
     *
     * When restify is used with express, you must install the session handler in express yourself (follow the no-sessionhandler errormessage for guidance).
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected session:{}|null = {};

}