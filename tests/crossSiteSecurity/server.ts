import express from "express"
import vite from "vite"
import {restfuncs} from "restfuncs-server"
import {MainframeService} from "./MainframeService.js"
import session from "express-session";
import crypto from "node:crypto";
import {StatelessService} from "./StatelessService.js";

(async () => {
    {
        // *** Main site: ****
        const port = 3000 // Adjust this in clientTests.ts also
        const checkArguments = (process.env.NODE_ENV === 'development' ? undefined : true) // Strictly require parameter checking for production

        const app = express()

        // Install session handler:
        app.use(session({
            secret: crypto.randomBytes(32).toString("hex"),
            cookie: {sameSite: true},
            saveUninitialized: false, // Only send a cookie when really needed
            unset: "destroy",
            store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
        }));

        // Remote service(s):
        app.use("/mainframeAPI", restfuncs(new MainframeService(), {checkArguments}))
        app.use("/statelessService", restfuncs(new StatelessService(), {checkArguments}))
        app.use("/allowedStatelessService", restfuncs(new StatelessService(), {checkArguments}))

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
        console.log("Foreign site app running on: http://localhost:" + port)
    }

})()
