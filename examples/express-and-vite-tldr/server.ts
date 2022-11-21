import express from "express"
import vite from "vite"
import {restify} from "restfuncs-server"
import {GreeterService} from "./GreeterService.js"

const port = 3000

const app = express()
app.use("/greeterAPI", restify( new GreeterService() )) // Serve remote service
app.use((await vite.createServer()).middlewares) // Serve client web by vite devserver
app.listen(port)

console.log("Server started: http://localhost:" + port)
