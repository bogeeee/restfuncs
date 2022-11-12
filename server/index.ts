import _ from "underscore"
import express, {Request, RequestHandler, Response, Router} from "express";


function isError(e: any) {
    return e !== null && typeof e === "object" && !e.hasOwnProperty("name") && e.name === "Error" && e.message;
}

/**
 * Enhances the funcs object with enhancementProps temporarily with a proxy during the call of callTheFunc
 *
 * The proxy is used to prevent resource conflicts with other (callThe-)funcs. Note that callTheFunc runs asyncronously, so in theory at the same time / overlapping with other funcs.
 * This way, only code inside callTheFunc can access the enhancementProps.
 * @param funcs
 * @param enhancementProps These properties are virtually applied to the funcs object
 * @param callTheFunc
 */
async function enhanceViaProxyDuringCall<F extends Record<string, any>>(funcs: F, enhancementProps: F, callTheFunc: (funcsProxy: F) => any, diagnosis_funcName: string) {
    // Create a proxy:
    let callHasEnded = false;
    const funcsProxy = new Proxy(funcs, {
        get(target: F, p: string | symbol, receiver: any): any {

            // Reject symbols (don't know what it means but we only want strings as property names):
            if(typeof p != "string") {
                throw new Error(`Unhandled : ${String(p)}` );
            }

            // get a property that should be enhanced ?
            if(enhancementProps[p] !== undefined) {
                if(callHasEnded) {
                    throw new Error(`Cannot access .${p} after the call to ${diagnosis_funcName}(...) has ended.`);
                }
                return enhancementProps[p];
            }

            if(callHasEnded) {
                throw new Error(`You must not hand out the this object from inside your ${diagnosis_funcName}(...) function. This is because 'this' is only a proxy (to make req, resp, ... available) but it MUST NOT be referenced after the call to prevent resources leaks.`);
            }

            return  target[p]; // normal property
        }
    });

    try {
        await callTheFunc(funcsProxy);
    }
    finally {
        callHasEnded = true;
    }
}

/**
 * Creates a handler/router to use with express.
 * @param funcs An object who's methods can be called remotely / are exposed as a rest service.
 */
export function createRESTFuncsHandler(funcs: object | RESTFuncs): Router {
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
            if(funcs[methodName] === undefined) {
                throw new Error(`You are trying to call a remote method that does not exist: ${methodName}`);
            }
            // @ts-ignore
            const method = funcs[methodName];
            if(typeof method != "function") {
                throw new Error(`${methodName} is not a function`);
            }

            const args = req.body;

            // Set headers to prevent caching: (before method invocation so the user has the ability to change the headers)
            resp.header("Expires","-1");
            resp.header("Pragma", "no-cache");

            let result;
            await enhanceViaProxyDuringCall(funcs, {req, resp}, async (funcs) => { // make .req and .resp safely available during call
                result = await method.apply(funcs, args); // Call method
            }, methodName);


            // Send result:
            result = result!==undefined?result:null; // Json does not support undefined
            resp.json(result);
        }
        catch (e) {
            resp.status(500);
            if(isError(e)) {
                // @ts-ignore
                resp.json({message: e.message, stack: e.stack})
            }
            else {
                resp.json(e);
            }
        }
    });

    return router;
}

/**
 * Service base class. Extend this and use {@see createRESTFuncsHandler} to install it in express.
 */
export class RESTFuncs implements Record<string, any> {
    /**
     * The currently running (express) request
     */
    req!: Request;

    /**
     * You can modify any header fields as you like
     */
    resp!: Response;
}