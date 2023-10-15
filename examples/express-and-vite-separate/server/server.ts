import express from "express"
import {createServer} from "vite"
import {ServerSession} from "restfuncs-server"
import {GreeterSession} from "./GreeterSession.js"
import session from "express-session";
import crypto from "node:crypto";

(async () => {
    const port = 3000

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
    app.use("/greeterAPI", GreeterSession.createExpressHandler() )

    // Client web:
    if(process.env.NODE_ENV === 'development') {
        // Serve client web through vite dev server:
        const viteDevServer = await createServer({
            server: {
                middlewareMode: true
            },
            root: "../client",
            base: "/",
        });
        app.use(viteDevServer.middlewares)
    } else {
        app.use(express.static('../client/dist')); // Serve pre-built web (cd ../client && npm run build)
    }

    app.listen(port)
    console.log("Server started: http://localhost:" + port)

})()
