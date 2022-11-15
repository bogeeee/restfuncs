import express from "express";
import vite from "vite";
import {restify} from "@restfuncs/server";
import {GreeterService} from "./GreeterService.js";

const port = 3000;

const app = express();

// Remote service(s):
app.use("/greeterAPI", restify( new GreeterService() ));

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

app.listen(port);
console.log("Server started: http://localhost:" + port)