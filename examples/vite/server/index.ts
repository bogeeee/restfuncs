import express from "express";
import vite from "vite";
import {createRESTFuncsHandler} from "@restfuncs/server";
import {GreeterFuncs} from "./GreeterFuncs.js";

const port = 3000;

(async () => {
    const app = express();

    app.use("/api", createRESTFuncsHandler( new GreeterFuncs() ));

    const development = true;

    if(development) {
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
    else {
        app.use(express.static('client/dist')); // Serve pre-built web
    }

    await app.listen(port);
    console.log("Server started: http://localhost:" + port)
})();