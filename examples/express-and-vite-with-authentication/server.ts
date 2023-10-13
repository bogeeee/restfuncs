import express from "express"
import vite from "vite"
import {MainframeSession} from "./MainframeSession.js"
import session from "express-session";
import crypto from "node:crypto";

(async () => {
    const port = 3000

    MainframeSession.options = {
        checkArguments: (process.env.NODE_ENV === 'development'?undefined:true) // Strictly require parameter checking for production
    }

    const app = express()

    // Install session handler:
    app.use(session({
        secret: crypto.randomBytes(32).toString("hex"),
        cookie: {sameSite: false}, // sameSite is not required for restfuncs's security but you could still enable it to harden security, if you really have no cross-site interaction.
        saveUninitialized: false, // Privacy: Only send a cookie when really needed
        unset: "destroy",
        store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against growing memory by a DOS attack. See https://www.npmjs.com/package/express-session
    }));

    // Remote service(s):
    app.use("/mainframeAPI", MainframeSession.createExpressHandler())

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
    console.log("Server started: http://localhost:" + port)

})()
