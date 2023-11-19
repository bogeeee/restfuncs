import express, {Express} from "express"
import {createServer} from "vite"
import {ServerSessionOptions, ServerSession, restfuncsExpress} from "restfuncs-server"
import {MainframeService} from "./MainframeService.js"
import session from "express-session";
import crypto from "node:crypto";
import {TestsService} from "./TestsService.js";
import {ControlService} from "./ControlService.js";
import helmet from "helmet"


(async () => {


    {
        // *** Main site: ****
        const port = 3000 // Adjust this in clientTests.ts also

        const app = restfuncsExpress()

        const commonOptions: ServerSessionOptions = {
            exposeErrors: true,
            logErrors: false
        }

        MainframeService.options = commonOptions;
        TestsService.options = commonOptions;

        //app.use(helmet({referrerPolicy: {policy: "strict-origin-when-cross-origin"}})); // Test that this does not corrupt stuff, also see below in front of the served web content

        app.use("/MainframeService", MainframeService.createExpressHandler());
        app.use("/TestsService", TestsService.createExpressHandler());

        class AllowedTestsService extends TestsService {
            static options = {...commonOptions, allowedOrigins: ["http://localhost:3666"]}
        }
        app.use("/AllowedTestsService", AllowedTestsService.createExpressHandler());

        class ForceTokenCheckService extends TestsService {
            static options = { ...commonOptions, devForceTokenCheck: true }
        }
        app.use("/ForceTokenCheckService", ForceTokenCheckService.createExpressHandler());

        class AllowedForceTokenCheckService extends TestsService {
            static options = { ...commonOptions, allowedOrigins: ["http://localhost:3666"], devForceTokenCheck: true }
        }
        app.use("/AllowedForceTokenCheckService", AllowedForceTokenCheckService.createExpressHandler());


        app.use("/ControlService", ControlService.createExpressHandler())

        // Pretend the browser does not send an origin:
        class TestsService_eraseOrigin extends TestsService {
            static options: ServerSessionOptions = {...commonOptions}
        }
        app.use("/TestsService_eraseOrigin", eraseOrigin, TestsService_eraseOrigin.createExpressHandler())

        // Pretend the browser does not send an origin:
        class AllowedTestsService_eraseOrigin extends TestsService {
            static options: ServerSessionOptions = {...commonOptions, allowedOrigins: ["http://localhost:3666"]}
        }
        app.use("/AllowedTestsService_eraseOrigin", eraseOrigin, AllowedTestsService_eraseOrigin.createExpressHandler())

        await serveClientWeb(app,4000);

        app.listen(port)
        console.log("Main app running on: http://localhost:" + port)
    }

    // ***** Foreign site: ****
    {
        const port = 3666
        const app = express()
        await serveClientWeb(app, 4666);
        app.listen(port)
        console.log("Foreign site app (some services CORS allowed to it) running on: http://localhost:" + port)
    }

    // ***** Evil site2: ****
    {
        const port = 3667
        const app = express()
        await serveClientWeb(app, 4667);
        app.listen(port)
        console.log("Evil site app (no services CORS allowed to it) running on: http://localhost:" + port)
    }

})()

function eraseOrigin (req: any, res: any, next: any) {
    if(req.method !== "OPTIONS") { // Only erase for regular methods, cause we want to test if the preflight works properly
        req.headers.origin = undefined
        req.headers.referer = undefined

        if (req.header("Origin")) {
            throw "Unexpected"
        }
    }
    next()
};


async  function serveClientWeb(app: Express, hmrPort: number) {
    /*
     // Test with helmet, that this does not corrupt stuff:
    app.use(helmet({
        contentSecurityPolicy: {directives: {
            "connect-src": "*"
            }},
        referrerPolicy: {policy: "strict-origin-when-cross-origin"
        }}));

     */
    // Client web:
    if (process.env.NODE_ENV === 'development') {
        // Serve client web through vite dev server:
        const viteDevServer = await createServer({
            cacheDir: `.vite/${hmrPort}`,
            server: {
                hmr: {
                    port: hmrPort
                },
                middlewareMode: true
            },
            root: "client",
            base: "/",
        });
        app.use(viteDevServer.middlewares)
    } else {
        app.use(express.static('client/dist')) // Serve pre-built web (npm run build)
    }
}