import express, {Express} from "express"
import {createServer} from "vite"
import {ServerSessionOptions, ServerSession, restfuncsExpress} from "restfuncs-server"
import {MainframeService} from "./MainframeService.js"
import session from "express-session";
import crypto from "node:crypto";
import {TestsService} from "./TestsService.js";
import {ControlService} from "./ControlService.js";


(async () => {


    {
        // *** Main site: ****
        const port = 3000 // Adjust this in clientTests.ts also

        const app = restfuncsExpress()

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
    req.headers.origin = undefined
    req.headers.referer = undefined

    if(req.header("Origin")) {
        throw "Unexpected"
    }
    next()
};


async  function serveClientWeb(app: Express, hmrPort: number) {
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