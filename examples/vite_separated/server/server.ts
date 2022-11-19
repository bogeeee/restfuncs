import express from "express"
import vite from "vite"
import {restify} from "@restfuncs/server"
import {GreeterService} from "./GreeterService.js"
import session from "express-session";
import crypto from "node:crypto";

(async () => {
    const port = 3000

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
    app.use("/greeterAPI", restify( new GreeterService() ))

    // Client web:
    if(process.env.NODE_ENV === 'production') {
        app.use(express.static('../client/dist')); // Serve pre-built web (cd ../client && npm run build)
    }
    else {
        // Serve client web through vite dev server:
        const viteDevServer = await vite.createServer({
            server: {
                middlewareMode: 'html'
            },
            root: "../client",
            base: "/",

        });
        app.use(viteDevServer.middlewares);
    }

    app.listen(port)
    console.log("Server started: http://localhost:" + port)

})()
