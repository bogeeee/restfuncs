import express from "express"
import {createServer} from "vite"
import {MainframeSession} from "./MainframeSession.js"
import session from "express-session";
import crypto from "node:crypto";
import {restfuncsExpress} from "restfuncs-server";

(async () => {
    const port = 3000

    MainframeSession.options = {
        devDisableSecurity: (process.env.NODE_ENV === 'development')
    }

    const app = restfuncsExpress()

    app.use("/mainframeAPI", MainframeSession.createExpressHandler())

    // Client web:
    if (process.env.NODE_ENV === 'development') {
        // Serve client web through vite dev server:
        const viteDevServer = await createServer({
            server: {
                middlewareMode: true
            },
            root: "client",
            base: "/",
        });
        app.use(viteDevServer.middlewares)
    } else {
        app.use(express.static('client/dist')) // Serve pre-built web (npm run build)
    }

    app.listen(port)
    console.log("Server started: http://localhost:" + port)

})()
