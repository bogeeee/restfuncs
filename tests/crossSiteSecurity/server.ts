import express from "express"
import vite from "vite"
import {restfuncs, RestfuncsOptions, ServerSession} from "restfuncs-server"
import {MainframeService} from "./MainframeService.js"
import session from "express-session";
import crypto from "node:crypto";
import {TestsService} from "./TestsService.js";
import {ControlService} from "./ControlService.js";


(async () => {
    {
        // *** Main site: ****
        const port = 3000 // Adjust this in clientTests.ts also
        const commonOptions: RestfuncsOptions = {
            checkArguments: (process.env.NODE_ENV === 'development' ? undefined : true), // Strictly require parameter checking for production
            exposeErrors: true,
            logErrors: false
        }


        const app = express()

        // Install session handler:
        app.use(session({
            secret: crypto.randomBytes(32).toString("hex"),
            cookie: {sameSite: true},
            saveUninitialized: false, // Only send a cookie when really needed
            unset: "destroy",
            store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
        }));

        // Remote service(s): Register them
        const services: {[name: string]: { service: ServerSession, options?:RestfuncsOptions} } = {
            "mainframeAPI":  { service:new MainframeService(), options: commonOptions},
            "testsService":  { service:new TestsService(), options: commonOptions},
            "allowedTestsService": { service:new TestsService(), options: {...commonOptions, allowedOrigins: ["http://localhost:3666"]}},
            "testsService_forceTokenCheck": { service:new TestsService(), options: {...commonOptions, devForceTokenCheck: true}},
            "allowedTestsService_forceTokenCheck": { service:new TestsService(), options: {...commonOptions, allowedOrigins: ["http://localhost:3666"], devForceTokenCheck: true}},
        }

        for(const name in services) {
            const service = services[name].service;
            service.id = name;
            app.use(`/${name}`, restfuncs(service, services[name].options))
        }

        app.use("/controlService", restfuncs(new ControlService(services), {allowedOrigins: "all", exposeErrors: true}))



        // Pretend the browser does not send an origin:
        const allowedTestsService_eraseOrigin = new TestsService();
        app.use("/allowedTestsService_eraseOrigin", eraseOrigin, restfuncs(allowedTestsService_eraseOrigin, {...commonOptions, allowedOrigins: ["http://localhost:3666"]}))
        services["/allowedTestsService_eraseOrigin"] = {service: allowedTestsService_eraseOrigin};


        // Client web:
        if (process.env.NODE_ENV === 'development') {
            // Serve client web through vite dev server:
            const viteDevServer = await vite.createServer({
                server: {
                    middlewareMode: 'html'
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
            const viteDevServer = await vite.createServer({
                server: {
                    middlewareMode: 'html'
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
            const viteDevServer = await vite.createServer({
                server: {
                    middlewareMode: 'html'
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
