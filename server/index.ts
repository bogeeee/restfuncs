import _ from "underscore"
import express, {RequestHandler, Router} from "express";


function isError(e: any) {
    return e !== null && typeof e === "object" && !e.hasOwnProperty("name") && e.name === "Error" && e.message;
}

/**
 * Creates a handler/router to use with express.
 * @param funcs An object who's methods can be called remotely / are exposed as a rest service.
 */
export function createRESTFuncsHandler(funcs: Object): Router {
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

            let result = await method.apply(funcs, args); // Call method

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