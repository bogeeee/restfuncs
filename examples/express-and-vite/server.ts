import express from "express"
import {createServer} from "vite"
import {GreeterSession} from "./GreeterSession.js"
import {restfuncsExpress} from "restfuncs-server";
import helmet from "helmet";

(async () => {
    const port = 3000

    const app = restfuncsExpress()

    app.use("/greeterAPI", GreeterSession.createExpressHandler() )

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
        app.use(helmet(), express.static('client/dist')) // Serve pre-built web (npm run build)
    }

    app.listen(port)
    console.log("Server started: http://localhost:" + port)

})()
