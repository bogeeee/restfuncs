import express from "express"
import {createServer} from "vite"
import {ServerSessionOptions, ServerSession} from "restfuncs-server"
import {MainframeService} from "./MainframeService.js"
import session from "express-session";
import crypto from "node:crypto";
import {TestsService} from "./TestsService.js";
import {ControlService} from "./ControlService.js";


(async () => {
    {
        // *** Main site: ****
        const port = 3000 // Adjust this in clientTests.ts also



        const app = express()

        // Install session handler:
        app.use(session({
            secret: crypto.randomBytes(32).toString("hex"),
            cookie: {sameSite: true},
            saveUninitialized: false, // Only send a cookie when really needed
            unset: "destroy",
            store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
        }));

        const commonOptions: ServerSessionOptions = {
            checkArguments: (process.env.NODE_ENV === 'development' ? undefined : true), // Strictly require parameter checking for production
            exposeErrors: true,
            logErrors: false
        }

        MainframeService.options = commonOptions;
        TestsService.options = commonOptions;

        // Remote service(s): Register them
        const services: { [name: string]: { service: typeof ServerSession } } = {
            "mainframeAPI": {service: MainframeService},
            "testsService": {service: TestsService},
            "allowedTestsService": {
                service: class extends TestsService {
                    static options = {...commonOptions, allowedOrigins: ["http://localhost:3666"]}
                }
            },
            "testsService_forceTokenCheck": {
                service: class extends TestsService {
                    static options = { ...commonOptions, devForceTokenCheck: true }
                }
            },
            "allowedTestsService_forceTokenCheck": {
                service: class extends TestsService {
                    static options = { ...commonOptions, allowedOrigins: ["http://localhost:3666"], devForceTokenCheck: true }
                }
            },
        }

        for(const name in services) {
            const service = services[name].service;
            //service.id = name;
            app.use(`/${name}`,  service.createExpressHandler())
        }

        ControlService.services = services;
        app.use("/controlService", ControlService.createExpressHandler())



        // Pretend the browser does not send an origin:
        class AllowedTestsService_eraseOrigin extends TestsService {
            static options: ServerSessionOptions = {...commonOptions, allowedOrigins: ["http://localhost:3666"]}
        }
        app.use("/allowedTestsService_eraseOrigin", eraseOrigin, AllowedTestsService_eraseOrigin.createExpressHandler())
        services["/allowedTestsService_eraseOrigin"] = {service: AllowedTestsService_eraseOrigin};


        // Client web:
        if (process.env.NODE_ENV === 'development') {
            // Serve client web through vite dev server:
            const viteDevServer = await createServer({
                server: {
                    middlewareMode: true
                },
                base: "/",
            });
            app.use(viteDevServer.middlewares)
        } else {
            app.use(express.static('dist/web')) // Serve pre-built web (npm run build)
        }

        app.listen(port)
        console.log("Main app running on: http://localhost:" + port)
    }

    // ***** Foreign site: ****
    {
        const port = 3666
        const app = express()
        // Client web:
        if (process.env.NODE_ENV === 'development') {
            // Serve client web through vite dev server:
            const viteDevServer = await createServer({
                server: {
                    middlewareMode: true
                },
                base: "/",
            });
            app.use(viteDevServer.middlewares)
        } else {
            app.use(express.static('dist/web')) // Serve pre-built web (npm run build)
        }

        app.listen(port)
        console.log("Foreign site app (some services CORS allowed to it) running on: http://localhost:" + port)
    }

    // ***** Evil site2: ****
    {
        const port = 3667
        const app = express()
        // Client web:
        if (process.env.NODE_ENV === 'development') {
            // Serve client web through vite dev server:
            const viteDevServer = await createServer({
                server: {
                    middlewareMode: true
                },
                base: "/",
            });
            app.use(viteDevServer.middlewares)
        } else {
            app.use(express.static('dist/web')) // Serve pre-built web (npm run build)
        }

        app.listen(port)
        console.log("Evil site app (no services CORS allowed to it) running on: http://localhost:" + port)
    }

})()

function eraseOrigin (req: any, res: any, next: any) {
    req.headers.origin = undefined
    req.headers.referer = undefined

    if(req.header("Origin")) {
        throw "Unexpected"
    }
    next()
};
