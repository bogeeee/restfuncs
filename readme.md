# Restfuncs

**Serve** a REST interface for your **plain functions** and seamlessly **RPC-call** them from the client (browser).

Tired of handcrafting every server API method + fetch / ajax request + (forgotten) error handling over and over? How about this:

**NOTE: This is the 1.0 branch and will be released as a NPM package soon. Please see the [documentation in NPM](https://www.npmjs.com/package/restfuncs) for the current 0.9x release.**  

## Usage 

**_server.js_**
```javascript
import restfuncs from "restfuncs-server"

restfuncs({
    greet: (name) =>  `Hello ${name} from the server`,
    // ... <- more functions go here
}, 3000) // specifying a port runs a standalone server
```

**_client.js_**

```javascript
import restfuncsClient from "restfuncs-client"

const remote = restfuncsClient("http://localhost:3000")
console.log(await remote.greet("Bob")) // Call in RPC style
```
Now your greet method is also available as a [REST interface, see below](#rest-interface).
<br/>
<br/>
<br/>

## Usage with express and end2end type safety

**_GreeterService.ts_**
```typescript
import {RestService} from "restfuncs-server" // (we want to have types for req and resp fields)

export class GreeterService extends RestService { // Define the service as a class...

    async greet(name: string) {
        return `Hello ${name} from the server`
    }

    // <- more methods go here
}
```

**_server.ts_**
```typescript
...

const app = express()
app.use("/greeterAPI", restfuncs( new GreeterService() ))
app.listen(3000)
```

**_client.ts_**
```typescript
import restfuncsClient from "restfuncs-client"
import {GreeterService} from "../path/to/server/or/its/packagename/GreeterService.js" // ...and import the class to have full type support on the client :)

const greeterService = restfuncsClient<GreeterService>("/greeterAPI")
console.log(await greeterService.greet("Bob"))
```
<br/>
<br/>
<br/>

# Security

## CORS
 
Restfuncs has built in CORS that plays together with its csrf protection. It is controlled by the `RestfuncsOptions.allowedOrigins` setting. See there for more detail.
You may set it if you:
- Host the backend and frontend on different (sub-) domains.
- Provide authentication methods to other web applications.
- Consume authentication responses from 3rd party authentication providers. I.e. form- posted SAML responses.
- Provide client side service methods to other web applications (that need the current user's session).
- Have a reverse proxy in front of this web app and you get an error cause the same-origin check fails for simple, non preflighted, requests like form posts. Alternatively check the trust proxy settings: http://expressjs.com/en/4x/api.html#app.settings.table (currently this does not work properly with express 4.x)


## CSRF protection
 
**Tl;dr:** **In a normal situation** (= no basic auth, no client-certs and using the restfuncs-client) **restfuncs already has a very strong CSRF protection** by default (`corsReadToken`, enforced by the client). For other situations, read the following:

Restfuncs has the following 3 protection levels (weakest to hardest) to protect against CSRF attacks. See list below.
You can enforce it by the `RestfuncsOptions.csrfProtectionMode` setting.  
**By default/ undefined, the client can decide the protection mode**. _"wait a minute, how can this be secure ?" See explanation_. This way, all sorts of clients can be served. Think of non-browser clients where CSRF does not have relevance, so their devs are not bugged with implementing token fetches.  
_Explanation: Restfuncs will raise an error, if browser clients (or i.e an attacker from another browser tab) with different protection modes try to [access the (same) session](#store-values-in-the-http--browser-session). Meaning, once the session is created, it stores from which protection mode it came from, and all following requests, that access this session, must pass the check / show the token accordingly. Also they must at first indicate that they play the same csrfProtection mode (think of attacker creating the session first)._ 

The above policy (let the clients decide) only covers sessions. So <strong>when using client-certificates or basic auth, you must explicitly decide for a setting</strong>, and you should use at least set it to `readToken` when dealing with browser clients.

Here are the modes. `RestfuncsOptions.csrfProtectionMode` / `RestfuncsClient.csrfProtectionMode` can be set to:

* `preflight` (**default**): Relies on the browser to make a CORS-preflight before doing the actual request and bail if that preflight failed. 
  The [~1.5% browsers which don't implement CORS](https://caniuse.com/cors) are blacklisted. This also works with all non-browser clients and they don't need to implement any measurements.
  [Simple requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests) are denied, unless they are [@safe](#simple-requests-and-safe).  
  A lot of the web out there relies on CORS-preflights, **but this method has at least a problem within the [specification](https://fetch.spec.whatwg.org/#http-requests)**:
  ````  
  A CORS-preflight request is a CORS request that checks to see if the CORS protocol is understood.
  ````
  It doesn't state that a browser has to stop the request after a negative preflight. The following actual request will again contain the info whether it's allowed to read the result and browsers could legally use this as point to bail. But at that point it's already too late: The request has been executed and makes a CSRF attacker happy.
* `corsReadToken` (**used by restfuncs-client**) This is a safer mode which works around this unclear in-spec/in-practice situation. The client must (if not already clear by `Origin` or `Referrer` headers) prove to have made a successful read, before the call is allowed to execute.  
   In detail (if you want to implement it yourself):
  - The Client calls the `getCorsReadToken()` service method to get a token string. Every service has that method inherited from the RestService base class. This the *read-proof*.
  - Every http request now includes the fields `csrfProtectionMode=corsReadToken` and `corsReadToken=<the token>` in the headers, in the query (GET only) or in the body like [usual named parameters](#rest-interface). See the `devForceTokenCheck` option for development. A http response code `480` is sent when the token was missing/incorrect. 
  
* `csrfToken`
  Strictly checks for a token that's been delivered in the start page (by your implementation). It's checked on every call / every session access _(enforced by client / enforced by server)_. The advantage is just that it relies less on in-depth defence / reflection of browser-behaviour and is commonly considered a simple-and-effective industry standard.  
  - You deliver/embed the csrfToken, which you've got from `restService.getCsrfToken(req: Request)`, inside your *main / index.html* page. This is the tricky/inconvenient part, cause you usually use some web packer.
  - When using the restfuncs client, you pass it to the options via {csrfProtectionMode:"csrfToken", csrfToken: theToken}.
  - With plain fetch requests, you include the parameter: `csrfToken=<the token>` _in the header, in the query (GET only) or in the body like a [usual named parameter](#rest-interface)_. A http response code `403` is sent when the token was missing/incorrect.



Notes:
- [More on the security concept](server/Security%20concept.md#csrf-protection)
- For, when having multiple services: _Services share the same session, but still every service has its individual corsReadToken and csrfToken (cause allowedOrigins or other security settings may be individual). For csrfTokens, you can pass all tokens as one comma separated string, and the server will just try them all out._ 


### Simple requests and @safe()

On some requests, the browser will not make preflights for legacy reason. These are called [Simple requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests). **Restfuncs blocks them** accordingly, but your methods can, if needed for some situations, be **opted in** for such calls by decorating them with `@safe()` which indicates, that you are sure, they make **read operations only**. See the JDDoc of `import {@safe} from "restfuncs-server"`

## Hardening security for the paranoid
- Install the cookie handler with `cookie: {sameSite: true}`, see the [session topic](#store-values-in-the-http--browser-session)
- Set `RestfuncsOptions.csrfProtectionMode` to `csrfToken` and implement the csrf token handover.
- TODO: List all sorts of disableXXX options to disable unneeded features

## Runtime arguments typechecking (shielding against evil input)

Enforces all your func's arguments to deeply match the declared types.  
But therefore, to have the type information available at runtime, we need to bother you with a little build setup:

Add the following to `tsconfig.json`
```json
  "compilerOptions": {
        
        
    "experimentalDecorators": true,
    "plugins": [
      {
        "transform": "typescript-rtti/dist/transformer"
      }
    ]
  }

```
And compile with `ttsc` instead of `tsc` (add `ttypescript` to devDependencies).


_If this was not set up correctly, a security warning will be logged at startup (so you won't be silently left insecure). The [examples](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite) already have this set up._

### Security Note:
**Objects can still be "poisoned" with additional properties** as this is still typescript conform. When you only have pure typescript code behind your func's, these just get ignored, but we're not living in an ideal world (i.e. the database just blindly storing all properties, or a non-ts lib using some unlisted fields), so **strongly keep that in mind!** 
See a discussion of that issue [here](https://github.com/bogeeee/restfuncs/issues/1).   


## Example projects

- [Bare minimal hello world web app](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite-tldr)
- [Hello world web app](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite) (proper / use as starter stack)
- [Hello world web app with server and client in separate dirs / packages](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite-separate) (if you prefer that cleaner layout)
- [Hello world Web app with authentication](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite-with-authentication) (uses things from the Advanced chapter)

_They use vite, which is a very minimalistic/ (zero conf) web packer with full support for React/JSX, Typescript, hot module reloading. Hope you'll like this as a starter stack for your webapp._

# Advanced

## REST interface

Like the name restfuncs suggests, there's also a REST interface for the case that you don't use the neat RPC client or you want to call these from other languages, etc.  
<br/>
Restfuncs follows a **zero conf / gracefully accepting** approach:  
The following service's example method...
```typescript
    async getBook(name: string, authorFilter?: string) {
        
    }
```
...can be called in almost **every imaginable way** through http like:

| Method | Url | Body | Description 
| :----: | :-----------------------: | :-------------: | :-----------: |
| GET | _/**getBook**/1984/George%20Orwell_ | | **List** arguments in the **path**
| GET | _/**getBook**?1984,George%20Orwell_ | | **List** arguments in the **query**
| GET | _/**getBook**?name=1984&authorFilter=George%20Orwell_ | | **Name** arguments in the **query**
| GET | _/**getBook**?__&lt;custom implementation&gt;_ | | Override the `parseQuery` method in your RestService subclass. See JSDoc.  [Here's a discussion about different url serializers](https://stackoverflow.com/questions/15872658/standardized-way-to-serialize-json-to-query-string) 
| GET | _/**book** ..._ | | Read **"GET book"** like `getBook`. Applies to other http verbs also. Additionally **"PUT book"** will try to call `updateBook` or `setBook` cause this sounds more common in programming languages.
| POST | _/**getBook**_ | `{"name": "1984", "authorFilter":"George Orwell"}` | **Name** arguments inside JSON body
| POST | _/**getBook**_ | `["1984", "George Orwell"]` | **List** arguments inside JSON body
| POST | _/**getBook**/1984_ | `"George Orwell"` | **Single** JSON primitive
| POST | _/**getBook**/1984_ | `George Orwell` | **Plain string**. For this you must explicitly set the `Content-Type` header to `text/plain`
| POST | _/**getBook**_ | `name=1984&authorFilter=George%20Orwell` | Classic **Html &lt;form&gt;** with `Content-Type` = `application/x-www-form-urlencoded`. Still remember these ? They can be used here as well ;)
| POST | _/**getBook**/1984_ | _&lt;Any binary data&gt;_ | **Binary Data**. Your function parameter (i.e. here the 2nd one) must be of type `Buffer`.

You are free to mix these styles ;) The styles are parsed in the order as listed, so arguments from a lower line in the table will -override _named_- or -append to _listed_- ones from above.

Also it's possible to have Readable and Buffers as parameters ...
```typescript
    async uploadAvatarImage(userName: string, image: Readable) {
        
    }
```
...can be called through http like:

| Method | Url | Body | Description
| :----: | :-----------------------: | :-------------: | :-----------: |
| POST | _/**uploadAvatarImage**/Donald%20Duck_ | &lt;<binary image data>&gt; | Binary data directly in the body (TODO)


### Content types
To specify what you **send** and how it should be interpreted, set the `Content-Type` header to 
 - `application/json` _(**default**)_ - Mind that JSON lacks support for some Data types.
 - [`application/brillout-json`](https://www.npmjs.com/package/@brillout/json-serializer) - Better. Fixes the above.
 - `text/plain` - For the one case, see table above.
 - `application/x-www-form-urlencoded` - For classic html `<form method="post">`.
 - _Any other_ - Can be consumed by `Readable` or `Buffer` parameter

### Auto value conversion
Parameter values will be **reasonably** auto converted to the actual declared type.
- The **query or path** can only carry strings, so they **will auto convert to boolean, number, Date, BigInt** types.
- **JSON**'s unsupported `undefined` (in arrays), `BigInt` and `Date` values will auto convert.   
  _Note that it currently doesn't support nested properties like `myFunc(i: {someDate: Date})`. Set and Map are also not supported. Have a look at the source of `RestService.autoConvertValueForParameter_fromJson` method to improve it._

_Restfuncs won't try to convert to ambiguous types like `string|bool` cause that would be too much magic and could cause unwanted behaviour flipping in your app (i.e., someone evil enters 'true' as username and this makes its way to a query param)._

_Note for the security cautious of you: After all this "wild" parameter collection and auto conversion, the actual call-ready parameters will be security-checked again in a [second stage](#runtime-arguments-typechecking-shielding-against-evil-input)._

### Receiving content (json-like result)
To specify what you want to **receive** in the response, Set the `Accept` header to
 - `application/json` _(**default**)_ - Mind that JSON lacks support for some Data types.
 - [`application/brillout-json`](https://www.npmjs.com/package/@brillout/json-serializer) - Better.

### Html / images / binary as a result

The service method must then explcitily set the content type and return the result via `string`, `Buffer` or `Readable`. Example:
```typescript
    async getAvatarImage(name: string) {
        this.resp?.contentType("image/x-png")
        return fs.createReadStream("/someImage.png") // Returns a Readable which is streamed to client
    }
```

 

## Mangle with raw request and response

`this.req` and `this.resp` are available in your methods during call to read / modify http headers, etc...   
_See [Request](https://expressjs.com/en/4x/api.html#req) and [Response](https://expressjs.com/en/4x/api.html#res) in the express API._

## Store values in the http- (browser) session...
...under the `session` field.
```typescript
class MyService {
    
    protected session= {visitCounter: 0}; // this simply becomes the initial/default for every new session (shallowly cloned). When having multiple RestServices, make sure, they all declare the **same** initial value !
    
    async countVisits() {
        this.session.visitCounter++
    }
}
```
For this to work, you must install a session/cookie middleware in express. I.e.:
```typescript
import session from "express-session"
import crypto from "node:crypto"

// ...

// Install session handler first:
app.use(session({
    secret: crypto.randomBytes(32).toString("hex"),
    cookie: {sameSite: false}, // sameSite is not required for restfuncs's security but you could still enable it to harden security, if you really have no cross-site interaction.
    saveUninitialized: false, // Privacy: Only send a cookie when really needed
    unset: "destroy",
    store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against growing memory by a DOS attack. See https://www.npmjs.com/package/express-session
}));

// app.use(...
```

_The standalone server has it already done for you._

**Security notes**
- Raw access to the session via `this.req.session` (or through plain express handlers or other middlewares) is not [shielded against csrf attacks](#csrf-protection). Use `this.session` instead, just like in the example above and you are fine.<br/><br/>
  _Feedback wanted: Do you use other express handlers / middlewares besides Restfuncs ? Or should we include the session handler completely into Restfuncs to make things simpler ?_     
- If using a JWT session handler, make sure that the browser is not able to read the session contents cause confidential csrfTokens / corsReadTokens are stored there. Either the content should be encrypted or the session-cookie should be `HttpOnly`.

  

## Intercept calls (server side)

Add the following method to your service and do what ever you want in there (i.e. handle errors, check for auth, filter args, filter result).
You have access to [this.req](https://expressjs.com/en/4x/api.html#req), [this.resp](https://expressjs.com/en/4x/api.html#res) and `this.session` as usual.
```
class MyService {

    protected async doCall(funcName:string, args: any[]) {
        return  await this[funcName](...args) // Call the original function
    }
    
    // ...
}
```

## Intercept calls (client side)

Similar as above. Add that function to the options of-, or in a subclass of RestfuncsClient.  

```typescript
const myService = restfuncsClient<MyService>("/myAPI", { // options
    
    async doCall(funcName:string, args: any[]) {
        return await this[funcName](...args) // Call the original function
    }
    
})
```

_If you want to mangle with request and response on the client, subclass it and override doFetch._ 

# API
Almost everything is already covered but for the full API details see the code's JSDoc.

# That's it !

### Things to come

- XSRF prevention (not investigated in this yet)
- Conform to OPENAPI/Swagger standards and automatically generate swagger docs
- Auto upgrade connection to websockets for faster calls or allow to send calls in batches
- Websockify: Provide a simple way to call functions on the client. I.e. just pass them as callbacks.
- Support for file uploads
- Easy basicauth handler for the standalone server  
- JsonP (maybe)

### Comparison to other RPC frameworks
[Comparison table](https://github.com/bogeeee/RPCFrameworksComparison)

### _Contribution_

See [DEVELOPMENT.md](DEVELOPMENT.md)

Places where your help would be needed

- Client code generator for Java, C#, Python, Rust. Typesafe / with types. The idea is to integrate this as a download inside the (upcoming) API -/ docs browser. This would all be generated automatically at runtime. We already have typescript-rtti but there also needs to be some transformer that makes the jsdoc available.   
- Security review this and of typescript-rtti
- Enhance [testcases for typescript-rtti](runtime-typechecking.test.ts) to cover the complete typescript language spec / check for all kinds of escapes.