import 'reflect-metadata' // Must import
import express, {Request, Response, Router} from "express";
import session from "express-session";
import {cloneError, enhanceViaProxyDuringCall} from "./Util";
import http from "node:http";
import crypto from "node:crypto";
import {reflect, ReflectedMethod} from "typescript-rtti";


const PROTOCOL_VERSION = "1.0"

const RTTIINFO = "To enable runtime typechecking, Add the following line into tsconfig.json/compileroptions \n" +
    "   \"plugins\": [{ \"transform\": \"typescript-rtti/dist/transformer\" }]";

export type RestfuncsOptions = {
    /**
     * Only for standalone server
     */
    path?: string

    /**
     * Enable checking your func's parameters at runtime.
     *
     * To make it work, you have to add the following line into tsconfig.json/compileroptions
     * "plugins": [{ "transform": "typescript-rtti/dist/transformer" }]
     *
     *
     * When undefined, a warning is issued. It's recommended to explicitly enable this.
     */
    checkParameters?: boolean
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

        app.use(createRESTFuncsRouter(<RestService>service, options));
        return app.listen(port);
    }
    else { // Express router
        const options:RestfuncsOptions = arg1 || {};

        if(typeof (options) !== "object") {
            throw new Error("Invalid argument");
        }

        return createRESTFuncsRouter(<RestService>service, options);
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
 * Throws an exception if you're not allowed to call the method from the outside
 * @param reflectedMethod
 */
function checkMethodAccessibility(reflectedMethod: ReflectedMethod) {
    if(reflectedMethod.isProtected) {
        throw new Error("Method is protected.")
    }
    if(reflectedMethod.isPrivate) {
        throw new Error("Method is private.")
    }

    // The other blocks should have already caught it. But just to be safe for future language extensions we explicitly check again:
    if(reflectedMethod.visibility !== "public") {
        throw new Error("Method is not public")
    }
}

/**
 * Throws an exception if args does not match the parameters of reflectedMethod
 * @param reflectedMethod
 * @param args
 */
function checkParameterTypes(reflectedMethod: ReflectedMethod, args: Readonly<any[]>) {
    // Make a stack out of args so we can pull out the first till the last. This wqy we can deal with ...rest params
    let argsStack = [...args]; // shallow clone
    argsStack.reverse();

    const errors: string[] = [];
    for(const i in reflectedMethod.parameters) {
        const parameter = reflectedMethod.parameters[i];
        if(parameter.isOmitted) {
            throw new Error("Omitted arguments not supported");
        }
        if(parameter.isRest) {
            argsStack.reverse();

            // Validate argsStack against parameter.type:
            const collectedErrorsForThisParam: Error[] = [];
            const ok = parameter.type.matchesValue(argsStack, collectedErrorsForThisParam); // Check value
            if(!ok || collectedErrorsForThisParam.length > 0) {
                errors.push(`Invalid value for parameter ${parameter.name}: ${collectedErrorsForThisParam.map(e => e.message).join(", ")}`);
            }

            argsStack = [];
            continue;
        }
        if(parameter.isBinding) {
            throw new Error(`Runtime typechecking of destructuring arguments is not yet supported`);
        }

        const arg =  argsStack.length > 0?argsStack.pop():undefined;

        // Allow undefined for optional parameter:
        if(parameter.isOptional && arg === undefined) {
            continue;
        }

        // Validate arg against parameter.type:
        const collectedErrorsForThisParam: Error[] = [];
        const ok = parameter.type.matchesValue(arg, collectedErrorsForThisParam); // Check value
        if(!ok || collectedErrorsForThisParam.length > 0) {
            errors.push(`Invalid value for parameter ${parameter.name}: ${collectedErrorsForThisParam.map(e => e.message).join(", ")}`);
        }
    }

    if(argsStack.length > 0) {
        throw new Error(`Too many arguments. Expected ${reflectedMethod.parameters.length}, got ${args.length}`);
    }

    if(errors.length > 0) {
        throw new Error(errors.join("; "))
    }
}

function diagnosis_isAnonymousObject(o: object) {
    if(o.constructor?.name === "Object") {
        return true;
    }

    return false;
}

export function isTypeInfoAvailable(restService: object) {
    const r = reflect(restService);

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
 * Creates a middleware/router to use with express.
 * @param service An object who's methods can be called remotely / are exposed as a rest service.
 */
function createRESTFuncsRouter(restService: RestService, options: RestfuncsOptions): Router {
    // @ts-ignore
    const sessionPrototype = restService.session || {}; // The user maybe has some initialization code for his session: Ie. {counter:0}  - so we want to make that convenient

    // Safety: Any non-null value for these may be confusing when (illegally) accessed from the outside.
    // @ts-ignore
    restService.req = null; restService.resp = null; restService.session = null;

    // Warn/error if type info is not available:
    if(!isTypeInfoAvailable(restService)) {
        const diagnosis_whyNotAvailable = diagnosis_isAnonymousObject(restService)?"Probably this is because your service is an anonymous object and not defined as a class.":RTTIINFO
        if(options.checkParameters) {
            throw new Error("Runtime type information is not available.\n" +  diagnosis_whyNotAvailable);
        }
        else if(options.checkParameters === undefined) {
            console.warn("**** Runtime type information is not available. This can be a security risk as your func's parameters cannot be checked automatically !\n" + diagnosis_whyNotAvailable)
        }
    }

    const router = express.Router();

    router.use(express.json({limit: Number.MAX_VALUE, strict: true, inflate: false})) // parse application/json. TODO: When used with authentication, parse after auth to make it safer

    router.use(async (req, resp, next) => {
        try {
            // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
            resp.header("Expires","-1");
            resp.header("Pragma", "no-cache");

            resp.header("restfuncs-protocol",  PROTOCOL_VERSION); // Let older clients know when the interface changed

            const methodName =  req.path.replace(/^\//, ""); // Remove trailing /

            // Parameter checks:
            if(!methodName) {
                throw new Error(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`);
            }
            if(new (class extends RestService{})()[methodName] !== undefined || {}[methodName] !== undefined) { // property exists in an empty service ?
                throw new Error(`You are trying to call a remote method that is a reserved name: ${methodName}`);
            }
            if(restService[methodName] === undefined) {
                throw new Error(`You are trying to call a remote method that does not exist: ${methodName}`);
            }
            const method = restService[methodName];
            if(typeof method != "function") {
                throw new Error(`${methodName} is not a function`);
            }
            let args = req.body;
            // Make sure that args is an array:
            if(args.constructor !== Array) {
                args = [];
            }
            // Runtime type checking of arguments:
            if(options.checkParameters || (options.checkParameters === undefined && isTypeInfoAvailable(restService))) { // Checking required or available ?
                const reflectedMethod = reflect(restService).getMethod(methodName); // we could also use reflect(method) but this doesn't give use params for anonymous classes - strangely'
                checkMethodAccessibility(<ReflectedMethod> reflectedMethod);
                checkParameterTypes(<ReflectedMethod> reflectedMethod,args);
            }

            let session = null;
            // @ts-ignore
            const reqSession = req.session as Record<string,any>|undefined;
            if(reqSession !== undefined) { // Express runs a session handler ?
                session = createProxyWithPrototype(reqSession, sessionPrototype); // Create the this.session object which is a proxy that writes/reads to req.session but shows service.session's initial values. This way we can comply with the sessions's saveUninitialized=true / data protection friendlyness
            }

            let result;
            // @ts-ignore
            await enhanceViaProxyDuringCall(restService, {req, resp, session}, async (restService) => { // make .req and .resp safely available during call
                // @ts-ignore
                if(restService.doCall) { // function defined (when a plain object was passed, it may be undefined= ?
                    // @ts-ignore
                    result = await restService.doCall(methodName, args); // Call method with user's doCall interceptor
                }
                else {
                    result = await method.apply(restService, args); // Call method
                }
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
 * Service base class. Extend it and use {@see restfuncs} on it.
 */
export class RestService {
    [index: string]: any

    /**
     * The currently running (express) request. See https://expressjs.com/en/4x/api.html#req
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected readonly req!: Request = null;

    /**
     * Response for the currently running (express) request. You can modify any header fields as you like. See https://expressjs.com/en/4x/api.html#res
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected readonly resp!: Response = null;


    /**
     * The browser/client session (for the currently running request). You can add any user defined content to it.
     * What you set as initial value here will also be the initial value of EVERY new session. Note that this initial session is not deeply cloned.
     *
     * When restfuncs is used with express, you must install the session handler in express yourself (follow the no-sessionhandler errormessage for guidance).
     *
     * Note: Only available during a request and inside a method of this service (which runs on a proxyed 'this'). Can't be reached directly from the outside.
     * @protected
     */
    // @ts-ignore
    protected session:{}|null = {};

    /**
     * Allows you to intercept calls. Override and implement it with the default body:
     * <pre><code>
     *      return  await this[funcName](...args) // Call the original function
     * </code></pre>
     *
     * You have access to this.req, this.resp and this.session as usual.
     *
     * @param funcName name of the function to be called
     * @param args args of the function to be called
     */
    protected async doCall(funcName:string, args: any[]) {
        return  await this[funcName](...args) // Call the original function
    }

}