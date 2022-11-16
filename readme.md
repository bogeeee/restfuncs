## Restfuncs

With `@restfuncs/server` you can **rest**ify(someObject) to make its member **func**tions callable via http REST API.   
With `@restfuncs/client` you can simply call them in a **R**emote **P**rocedure **C**all style. With full type support.


## Most simple example (standalone http server)

_server.js_
```javascript
import {restify} from "@restfuncs/server"

restify({
    greet(name) {
        return `Hello ${name} from the server`
    }
}, 3000) // specifying a port runs a standalone server
```
<br/>

_client.js_

```javascript
import {restClient} from "@restfuncs/client"

const remote = restClient("http://localhost:3000")
console.log(await remote.greet("Bob"))
```

## Proper example with express and type support

_GreeterService.ts_
```typescript
import {RESTService} from "@restfuncs/server"

export class GreeterService extends RESTService { // Define the service

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // ... more functions go here
}
```

<br/>

_server.ts_
```typescript
import express from "express"
import {restify} from "@restfuncs/server"
import {GreeterService} from "./GreeterService.js"

const app = express()
app.use("/greeterAPI", restify( new GreeterService() ))
app.listen(3000)
```

<br/>

_client.ts_
```typescript
import {restClient} from "@restfuncs/client"
import {GreeterService} from "../path/to/server/or/packagename/GreeterService.js" // Import the service to have type support

const greeterService = restClient<GreeterService>("/greeterAPI")
console.log(await greeterService.greet("Bob"))
```


Here you'll find this as a full working example project. _It uses vite, which is a very minimalistic/ (zero conf) web packer with full support for React/JSX, Typescript, hot module reloading. Hope you'll like this as a starter stack for your webapp._

## Advanced

### Mangle with raw request and response

[this.req](https://expressjs.com/en/4x/api.html#req) and [this.resp](https://expressjs.com/en/4x/api.html#res) are available in your methods during call to read / modify http headers etc. You can even [this.resp.send](https://expressjs.com/en/4x/api.html#res.send) a non-json response.

### Intercept calls

Override the following method in your service _(=just add the function to it)_
```typescript
async doCall(functionName, args) {
    return this[functionName](...args) // Call the function
}
```
There you can (also) mangle with [this.req](https://expressjs.com/en/4x/api.html#req) and [this.resp](https://expressjs.com/en/4x/api.html#res)  / try-catch-finally / surround with whatever control structure you like.

### Also on the client side ?

Same same. Just add the mentioned method to the proxy (= i.e. `remote` / `greeterService`) . [this.req](https://developer.mozilla.org/en-US/docs/Web/API/Request) / [this.resp](https://developer.mozilla.org/en-US/docs/Web/API/response) will be the types from the [Fetch API](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API):

## That's it !

###Further notes

This is still a proof-of-concept, as you see from the version number. 
**Types are not checked** at runtime on the server **yet**, so this is a **security risk** when you don't check them yourself.

### Things to come

- Runtime type checking / protection as mentioned above
- XSRF prevention (not investigated in this yet)
- Conform to OPENAPI/Swagger standards and automatically generate swagger docs
- Auto upgrade connection to websockets for faster calls or allow to send calls in batches
- Websockify: Provide a simple way to call functions on the client (the other way around)   
- Support for file uploads
- JsonP (maybe)