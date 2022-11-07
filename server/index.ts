import _ from "underscore"
import express, {RequestHandler, Router} from "express";


function isError(e: any) {
    return e !== null && typeof e === "object" && !e.hasOwnProperty("name") && e.name === "Error" && e.message;
}

export function createRemoteServiceRouter(remoteService: Object): Router {
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
            if(remoteService[methodName] === undefined) {
                throw new Error(`You are trying to call a remote method that does not exist: ${methodName}`);
            }
            // @ts-ignore
            const method = remoteService[methodName];
            if(typeof method != "function") {
                throw new Error(`${methodName} is not a function`);
            }

            const args = req.body;

            const result = await method.apply(remoteService, args); // Call method

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