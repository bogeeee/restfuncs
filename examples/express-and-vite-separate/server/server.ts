import express from "express"
import {createServer} from "vite"
import {restfuncsExpress, ServerSession} from "restfuncs-server"
import {GreeterSession} from "./GreeterSession.js"
import session from "express-session";
import crypto from "node:crypto";

(async () => {
    const port = 3000

    const app = restfuncsExpress()

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
