import express, {Request, Response, Router} from "express";
import {cloneError, enhanceViaProxyDuringCall} from "./Util";
import http from "node:http";


export type RestifyOptions = {
    /**
     * Only for standalone server
     */
    path?: string
}

/**
 * Makes service's member functions callable via REST in a standalone http server.
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
 * @param service
 * @return
 */
export function restify(service: object | RESTService, options?: RestifyOptions): Router;
export function restify(service: object | RESTService, arg1: any, arg2?: any): any {

    // Safety: Any non-null value for these may be confusing when (illegally) accessed from the outside.
    // @ts-ignore
    service.req = null; service.resp = null; service.session = null;

    if(typeof(arg1) == "number") { // standalone ?
        const port = arg1;
        const options:RestifyOptions = arg2 || {};

        if(typeof (options) !== "object") {
            throw new Error("Invalid argument");
        }

        const app = express();
        app.use(createRESTFuncsRouter(service, options));
        return app.listen(port);
    }
    else { // exx
        const options:RestifyOptions = arg1 || {};

        if(typeof (options) !== "object") {
            throw new Error("Invalid argument");
        }

        return createRESTFuncsRouter(service, options);
    }
}



/**
 * Creates a middleware/router to use with express.
 * @param service An object who's methods can be called remotely / are exposed as a rest service.
 */
function createRESTFuncsRouter(service: object | RESTService, options: RestifyOptions): Router {
    const router = express.Router();

    router.use(express.json({limit: Number.MAX_VALUE, strict: true, inflate: false})) // parse application/json. TODO: When used with authentication, parse after auth to make it safer

    router.use(async (req, resp, next) => {
        try {
            const methodName =  req.path.replace(/^\//, ""); // Remove trailing /

            // Parameter checks:
            if(!methodName) {
                throw new Error(`No method name set as part of the url. Use ${req.baseUrl}/yourMethodName.`);
            }
            // @ts-ignore
            if(new (class extends RESTService{})()[methodName] !== undefined || {}[methodName] !== undefined) { // property exists in an empty service ?
                throw new Error(`You are trying to call a remote method that is a reserved name: ${methodName}`);
            }
            // @ts-ignore
            if(service[methodName] === undefined) {
                throw new Error(`You are trying to call a remote method that does not exist: ${methodName}`);
            }
            // @ts-ignore
            const method = service[methodName];
            if(typeof method != "function") {
                throw new Error(`${methodName} is not a function`);
            }

            const args = req.body;

            // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
            resp.header("Expires","-1");
            resp.header("Pragma", "no-cache");

            let result;
            await enhanceViaProxyDuringCall(service, {req, resp}, async (funcs) => { // make .req and .resp safely available during call
                result = await method.apply(funcs, args); // Call method
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
 * Service base class. Extend this and use {@see createRESTFuncsRouter} to install it in express.
 */
export class RESTService implements Record<string, any> {
    /**
     * The currently running (express) request
     */
    protected readonly req!: Request;

    /**
     * You can modify any header fields as you like
     */
    protected readonly resp!: Response;
}