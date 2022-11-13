With `@restfuncs/server` you can **rest**ify(someObject) to make its member **func**tions callable via REST API. 
On the client, use the `@restfuncs/client` to simply call them as if they were local. With full type support.


## Most simple example (standalone)

_server.js_

    import {restify} from "@restfuncs/server"

    restify({
        greet(name) {
            return `hello ${name} from the server`
        }
    }, 3000) // port


_client.js_

    import {restClient} from "@restfuncs/client
    
    const remote = restClient("http://localhost:3000")
    console.log(await remote.greet("Bob"));


## Proper example with express webserver and type support

_server/GreeterService.ts_

    export class GreeterService extends RESTService {

        async greet(name: string) {
            return `hello ${name} from the server`
        }

        // ... more functions go here
    }

_server/index.ts_

    import express from "express";
    import {restify} from "@restfuncs/server"
    import {GreeterService} from "./GreeterService.js";

    const app = express();
    app.use("/greeterAPI", restify( new GreeterService() ));
    app.listen(3000);

_client/index.ts (included from index.html)_

    import {restClient} from "@restfuncs/client
    import {GreeterService} from "../path/to/server/code/GreeterService.js"; // Import to have types
    
    const greeterService = restClient<GreeterService>("/greeterAPI")
    console.log(await greeterService.greet("Bob"));



Here you'll find this as a full working example. _It uses vite, which is a very minimalistic/ (zero conf) web packer but with full support for React/JSX, Typescript, hot module reloading. Hope you'll like it as a starter stack for your webapp._

## Advanced

### Mangle with raw request and response

[this.req](https://expressjs.com/en/4x/api.html#req) and [this.resp](https://expressjs.com/en/4x/api.html#res) are available in your methods during call to read / modify http headers etc.

### Intercept calls

Override the following method in your service _(=just add the function)_

    async doCall(functionName, args) {
        return this[functionName](...args); // Call the function
    }

There you can mangle with [this.req](https://expressjs.com/en/4x/api.html#req) and [this.resp](https://expressjs.com/en/4x/api.html#res)  / try-catch-finally / surround with whatever control structure you like, or even [this.resp.send](https://expressjs.com/en/4x/api.html#res.send) a non-json response. No more explanation needed. All hacking should be your's.

### Also on the client side ?

Same same. Just add the mentioned method to the proxy (= i.e. `remote` / `greeterService`) . [this.req](https://developer.mozilla.org/en-US/docs/Web/API/Request) / [this.resp](https://developer.mozilla.org/en-US/docs/Web/API/response) will be the types from the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API):

## That's it !

###Further notes

This is still a proof-of-concept, as you see from the version number. 
**Types are not checked** at runtime on the server **yet**, so this is a **security risk** when you don't check them yourself.

### Things to come (please donate, so i won't be stuck away with some boring contract work* ;) )

- Runtime type checking / protection as mentioned above
- XSRF prevention (not investigated in this yet)
- Conform to OPENAPI/Swagger standards and automatically generate swagger docs
- Auto upgrade connection to websockets for faster calls
- Websockify: Provide a simple way to call functions on the clinet (the other way around)   
- Support for file uploads
- JsonP (maybe)

_* Also if you want to hire me as a freelancer (in the EU), please contact me._