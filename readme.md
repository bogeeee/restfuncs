# RestFuncs

Tired of handcrafting every server API method + fetch / ajax request + (forgotten) error handling over and over ?

With `@restfuncs/server` you can just **rest**ify(yourServiceObject) to make its member **func**tions available via a http REST API.   
With `@restfuncs/client` you can then simply call them in a **R**emote **P**rocedure **C**all style. With full type support.


## Usage 

_server.js_
```javascript
import {restify} from "@restfuncs/server"

restify({
    greet: (name) =>  `Hello ${name} from the server`    
}, 3000) // specifying a port runs a standalone server
```
<br/>

_client.js_

```javascript
import {restClient} from "@restfuncs/client"

const remote = restClient("http://localhost:3000")
console.log(await remote.greet("Bob"))
```

## Usage with express and type support

_GreeterService.ts_
```typescript
import {RestService} from "@restfuncs/server"

export class GreeterService extends RestService { // Define the service as a class...

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // <- more functions go here
}
```

<br/>

_server.ts_
```typescript
...

const app = express()
app.use("/greeterAPI", restify( new GreeterService() ))
app.listen(3000)
```

<br/>

_client.ts_
```typescript
import {restClient} from "@restfuncs/client"
import {GreeterService} from "../path/to/server/or/its/packagename/GreeterService.js" // ...and import the class to have full type support on the client :)

const greeterService = restClient<GreeterService>("/greeterAPI")
console.log(await greeterService.greet("Bob"))
```
## Example projects

- [Bare minimal hello world web app](examples/express-and-vite-tldr)
- [Hello world web app (proper / use as starter stack)](examples/express-and-vite)
- [Hello world web app with server and client in separate dirs / packages](examples/express-and-vite),
- [Hello world Web app with authentication](examples/express-and-vite) (uses things from the Advanced chapter)

_They use vite, which is a very minimalistic/ (zero conf) web packer with full support for React/JSX, Typescript, hot module reloading. Hope you'll like this as a starter stack for your webapp._

## Advanced

### Mangle with raw request and response

`this.req` and `this.resp` are available in your methods during call to read / modify http headers, etc...   
_See [Request](https://expressjs.com/en/4x/api.html#req) and [Response](https://expressjs.com/en/4x/api.html#res) in the express API._

### Store values in the http- (browser) session...
...under the `this.session` object.
```typescript
restify({
    session: {visitCounter: 0}, // this becomes the default for every new session (shallowly cloned).
    
    countVisits: () => this.session.visitCounter++
})
```
For this to work, you must install a session/cookie middleware in express. I.e.:
```typescript
import session from "express-session"
import crypto from "node:crypto"

// ...

// Install session handler:
app.use(session({
    secret: crypto.randomBytes(32).toString("hex"),
    cookie: {sameSite: true},
    saveUninitialized: false, // Only send a cookie when really needed
    unset: "destroy",
    store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
}));
```

_The standalone server has it already done for you._

### Intercept calls (server side)

Override the following method in your service _(=just add the function to it)_ and do what ever you want in there (i.e. handle errors, check for auth, filter args, filter result).
You have access to [this.req](https://expressjs.com/en/4x/api.html#req), [this.resp](https://expressjs.com/en/4x/api.html#res) and `this.session` as usual.
```
protected async doCall(funcName:string, args: any[]) {
    return  await this[funcName](...args) // Call the original function
}
```

### Intercept calls (client side)

Similar as above. Add that function to the options, _or override it in a subclass of RestClient_.  

```typescript
const greeterService = restClient<GreeterService>("/greeterAPI", {
    
    async doCall(funcName:string, args: any[]) {
        return await this[funcName](...args) // Call the original function
    }
    
})
```

_If you want to mangle with request and response on the client, subclass it and override doHttpCall._ 


## API
Most is already covered but for the full API details see the code's JSDoc.

## Security

**Types are not checked** at runtime on the server **yet**, so this is a **security risk** when you don't check them yourself.

## That's it !

### Things to come

- Runtime type checking / protection as mentioned above
- XSRF prevention (not investigated in this yet)
- Conform to OPENAPI/Swagger standards and automatically generate swagger docs
- Auto upgrade connection to websockets for faster calls or allow to send calls in batches
- Websockify: Provide a simple way to call functions on the client. I.e. just pass them as callbacks.
- Support for file uploads
- Easy basicauth handler for the standalone server  
- JsonP (maybe)