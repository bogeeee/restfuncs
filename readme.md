# Restfuncs

**Serve** a REST interface for your **plain functions** and seamlessly **RPC-call** them from the client (browser).

Tired of handcrafting every server API method + fetch / ajax request + (forgotten) error handling over and over? How about this:


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

## CSRF protection
 
TLDR; In a normal situation (= no basic auth, no client-certs, using the restfuncs-client) restfuncs already has a very strong CSRF protection out of the box (CORS readproof tokens). For other situations, read the following:

Restfuncs has the following 3 protection levels (weakest to hardest) to protect against CSRF attacks. See table.
You can enforce it by the `RestfuncsOptions.csrfProtection` setting.  
**By default/ undefined, the client can decide the protection mode**. _"wait a minute, how can this be secure ?" See explanation_. This way, all sorts of clients can be served. Think of non-browser clients where CSRF does not have relevance, so their devs are not bugged with implementing any tokens.  
_Explanation: There will be an error if browser clients (or i.e an attacker from another browser tab) with different protection modes try to access the same session. Meaning, once the session is created, it stores from which protection mode it came and all requests, that access this session, must pass the check / show the token accordingly. Also they must at first indicate that they play the same csrfProtection mode (think of attacker creating the session first)._ 

The above policy (let the clients decide) only covers sessions. So <strong>when using client-certificates or basic auth, you must explicitly decide for a setting</strong>, and you should use at least set it to `readToken` when dealing with browser clients.

`RestfuncsOptions.csrfProtection` or `RestfuncsClient.csrfProtection` can be

* `preflight` (**default** if no csrfProtection header was sent): Relies on the browser making a CORS preflight before doing the actual request and bail if that preflight fails. 
  The [~1.5% browsers which don't implement CORS](https://caniuse.com/?search=cors) are blacklisted.
  
* `corsReadToken` (**default by restfuncs-client**)
* `csrfToken`
  When having multiple `RestfuncService`s on one server, you must present that individual token for that specific service (cause services can have different `allowedOrigins` settings so they might have different security implications).
  But you can just pass all the token that you've got as a comma separated list which makes Restfuncs will try out all till one matches.

Also see the `RestfuncsOptions.allowedOrigins` settings. This controls how CORS headers will be sent. **Don't** use a 3rd party CORS middleware for that!


There's the old question of [whether to simply rely on CORS or implement CSRF tokens](https://stackoverflow.com/questions/24680302/csrf-protection-with-cors-origin-header-vs-csrf-token?noredirect=1&lq=1).


Restfuncs relies on browsers, to preflight their requests. This is widely adopted in all browsers since ~2009.
There are some exceptions, called simple requests, where no preflights are done for legacy reasons. To secure those, these methods have to be opted in for such calls by decorating them with `@safe()`. See the JDDoc of `import {@safe} from "restf"

## Hardening security for the paranoid
- Set `RestfuncsOptions.csrfProtection` to `csrfToken` and implement the csrf token logic.
- TODO: List all sorts of disableXXX options to disable unneeded features

## get... methods can be triggered cross site

Methods starting with `get` can be called by http GET. This means, they can be triggered cross site, even in the context of the logged on user! 
To prevent against XSRF attacks, make sure these methods are [safe](https://developer.mozilla.org/en-US/docs/Glossary/Safe/HTTP), i.e., perform read-only operations only.  
Using 'SameSite' cookies (like in the example) can mitigate this but works only for [~95% of browsers](https://caniuse.com/?search=samesite) and may not always applicable, i.e. when using 3rd party login providers.  

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

# REST interface

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
...under `session` field.
```typescript
class MyService {
    
    protected session: {visitCounter: 0}, // this becomes the default for every new session (shallowly cloned).
    
    countVisits: () => this.session.visitCounter++
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
    cookie: {sameSite: true},
    saveUninitialized: false, // Only send a cookie when really needed
    unset: "destroy",
    store: undefined, // Defaults to MemoryStore. You may use a better one for production to prevent against DOS/mem leak. See https://www.npmjs.com/package/express-session
}));

// app.use(...
```

_The standalone server has it already done for you._

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