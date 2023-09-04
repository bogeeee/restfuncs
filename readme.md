_This is the 2.0 Version (API redesign), planned to be released before November 2023. Stay tuned ! Feedback welcome. 
The [release on NPM](https://www.npmjs.com/package/restfuncs) is still an older version. Please refer to the docs there._
# Restfuncs - HTTP API done proper (coming soon)

## Intro + features

With restfuncs, you write your API endpoints just as **plain typescript functions**, further called "service methods".
Nothing more is needed for such a method (no ZOD and no routing @decorators). Restfuncs will provide (a):
- **Zero conf REST API**. Needs no routing @decorators, you can just call them in *all* (imaginable) ways.
- **RPC client**  Just call your service method from the client/browser as if it was lokal like 'await myRemoteService.myAPIMethod(...)`, while enjoying full end2end type safety.
  - With **Websockets** TODO: The client tries to use very fast websockets. Cookie session, CORS setup and CSRF protection is automatically synced with / behaves like the classic http requests. So nothing to worry - all just working.
- Typescript native **input validation**. You already declared your parameters by typescript (can be any complex type !), restfuncs will validate that automatically.  _No need to repeat yourself in any inconvenient declaration language, **no need to learn ZOD**. It is achieved by a build plugin that uses the [typescript-rtti](https://typescript-rtti.org/) library_
- Typescript native **result validation** TODO. Also your output/result gets validated and shaped to what's declared. Improves safety and allows for [typescript tips and tricks](TODO) to shape an object to the form you want.
- FUTURE (after 1.0): **API browser** (just point the url to your partners and they've got all the information and examples they need to call your methods from other programming languages )
  - FUTURE (after 1.0):  Also generates an **Openapi spec**.
- Typesafe browser **sessions**, delivered via JWT cookies TODO.
- **Callback functions** as usual parameters TODO. Easy and great for reacting to events (subscriptions), progress bars, chat rooms, games, ... _Those calls get **pushed** via websockets of course._ There are options for skipping and rate limiting.
- **CSRF protection** by default / zero-conf.
- **CORS** (cross-origin resource sharing). See `ServiceOptions.allowedOrigins`.
- Simple **file uploads** TODO. You can [use the Restfuncs client](#ltboilerplate-cheat-sheet---all-you-need-to-knowgt) or [multipart/mime forms (classic)](#rest-interface).
- **Serve/stream resources**: You can also use your service methods to [serve/stream resources like html pages/images/pdfs/...](#html--images--binary-as-a-result) just by returning a `Readable`/`Buffer`/`string`
- **Scales** to a multi node environment (all tokens and JWT cookies are *stateless* / use cryptographic signing)
- Proper **error handling** and logging.
- **Basic auth** handler TODO. Http-session based auth is also covered by the [example](https://github.com/bogeeee/restfuncs/tree/1.x/examples/express-and-vite-with-authentication)
- **[Collection of example projects](#example-projects)**. Grab them, if you're looking for a quick starter for your single page application.
- **Tinkering friendly** library by exposing a clear OOP API. You are allowed and encouraged to subclass and override methods. Includes .ts source code, source maps and declaration maps in the published NPM package, so you can ctrl+click or debug-step yourself right into the source code and have some fun with it - i hope this inspires other lib authors ;). TODO: Document basic-call-structure.md  
- **Very compact** conceptual **documentation**. "All you need to know" fits on 2.5 screen pages. Further is shown by your IDE's intellisense + friendly error messages give you advice. So let's not waste words and [get right into it](#ltboilerplate-cheat-sheet---all-you-need-to-knowgt):

# &lt;Boilerplate cheat sheet - all you need to know&gt;

**MyServerSession.ts**

````typescript
import {ServerSession, UploadFile} from "restfuncs-server";

/**
 * An instance of MyServerSession is created for every browser session.
 * All the fields are stored in a JWT cookie. If you have multiple ServerSession classes (i.e. for a better file structure organization), the fields will overlap.
 */
export class MyServerSession extends ServerSession {

  static options: ServerSessionOptions = {/* ServerSessionOptions */}

  myLogonUserId?: string // As sayed, stored in the cookie. Make use of the fact that this property is shared with all your ServerSessions classes. It is adviced to have a common base class for all logon specific fields and methods.

  /**
   * ---- Write your API method as a plain typescript method... ----
   * This JSDoc also gets outputted in the API browser / OpenAPI spec.
   * Use the 'public' modifier to make them callable from a client.
   * @param myComplexParam Your parameters can be any complex typescript type. They are automatically validated at runtime.
   * @param myCallback You can have server->client callback functions as parameters. Their arguments also get validated and shaped (like, see return). Here we send the progress of the file upload. // TODO: allow deeply nested
   * @param myUploadFile Use the UploadFile type anywhere in your parameters (can be multiple, a ...rest param, or deeply nested). As soon as you suck on the stream, the restfuncs client will send that corresponding upload in an extra http request.
   */
  public myAPIMethod(myComplexParam: { id?: number, name: string }, myCallback?: (percentDone: number) => void, myUploadFile?: UploadFile) {
    // ADVANCED:
    // this.req.... // Access the raw (express) request.  Field is simulated at call time.
    // this.res.... // Access the raw (express) response. Field is simulated at call time.
    // (myCallback as Callback).... // Access some options under the hood

    return `Hello ${user.name}` // The output automatically gets validated and shaped into the declared or implicit return type of `myAPIMethod`. Extra properties get removed. TODO: See Typescript tips an tricks on how to shape the result
  }

  // public static async getAllMyItems(...) {} // TODO: do we need it ? Use static methods for serving stuff that doesn't use this sessions's fields. They can also be called by the client marked 'public' !
    
  // ... <-- More API methods  
  // ... <-- Methods that serve html / images / binary. See TODO:baseurl/#html--images--binary-as-a-result    
  // ... <-- Override `doCall` method to intercept each call (i.e. check for auth (see example project), handle errors, filter args, filter result).
  // ... <-- Override other methods from the Service base class for advanced tweaking (use intellisense and read the method description)
}
````
**server.ts**
````typescript
import {restfuncsExpress} from "restfuncs-server/Server";
import {MyServerSession} from "MyServerSession";

const app = restfuncsExpress({/* options */}) // Drop in replacement for express. Installs a jwt session cookie middleware and the websockets listener. Recommended.

app.use("/myAPI", MyServerSession.createExpressHandler()) // ---- Serve it ---- 
// ... app.use(express.static('dist/web')) // Serve pre-built web pages / i.e. by a packager like vite, parcel or turbopack. See examples.
// ... app.use(...) <-- Serve *other / 3rd party* express routes here. SECURITY: These are not covered by restfuncs CSRF protection. Don't do write/state-changing operations in here ! Instead do them by MyService.

app.listen(3000); // Listen on Port 3000
````
**client.ts**
````typescript
// Use a packager like vite, parcel or turbopack to deliver these modules to the browser (as usual, also see the example projects): 
import {UploadFile} from "restfuncs-server";
import {RestfuncsClient} from "restfuncs-client";
import {MyServerSession} from "../path/to/server/code/or/its/packagename/MyServerSession.js" // Import the class to have full type support on the client

const remote = new RestfuncsClient<MyServerSession>("/myAPI", {/* options */}).proxy; // Tip: For intercepting calls (+ more tweaks), sublcass it and override `doCall`. See the auth example.  

// ** Finally call your API method: **
console.log( await remote.myAPIMethod({name: "Hans"}) );

// ** Example with a callback + a file upload: **
const myFile = document.querySelector("#myFileInput").files[0]; // Retrieve your File object(s) from an <input type="file" /> (here), or from a DragEvent.dataTransfer.files
await remote.myAPIMethod(...,  (progress) => console.log(`myCallback says: ${progress}% uploaded`),  myFile as UploadFile) // Cast to UploadFile or ts-ignore it    
````

### Setting up the build (the annoying stuff)

**tsconfig.json**
````json
"compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "plugins": [{ "transform": "restfuncs/transformer" }]
}
````
**package.json**
````json
"scripts": {
    "dev": "nodemon -e ts --exec \"clear && ttsc --build ts-node server.js\"",
    "clean": "ttsc --build --clean",
    "build": "ttsc --build --force",
    "start": "ts-node server.js"
}
"devDependencies": {
    "restfuncs-transformer": "^TODO"
}
````
_Here we compile with `ttsc` (instad of tsc) which **allows for our compiler plugin** in tsconfig.json. We use / recommend `ts-node` on top of that because it works proper with debugging (recognizes sources maps, hits the breakpoints, outputs proper stracktraces, opposed to plain `node` here).
In some cases where a (configuration) decision must be made 
See also this [example/package.json](examples/express-and-vite/tsconfig.json) which additionaly has a faster `tsx` based dev script and does the vite packaging for the client/browser._

**Security note:** When using client certificates, you must read the [CSRF protection chapter](#csrf-protection).
## &lt;/Boilerplate cheat sheet&gt;

_Congrats, you've got the concept!  
Now use your IDE's intellisense and have a quick browse through the `/* XxxOptions */` and also the `Callback` and `UploadFile` description/members. That JSDoc is considered the official documentation and it won't be repeated here.
In some cases where more configuration needs to be decided for, contextual error messages will guide you. So don't be scared of them and read them and see them as part of the concept._

<br/><br/><br/><br/><br/><br/>

# Example projects

- [Bare minimal hello world web app](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite-tldr)
- [Hello world web app](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite) (proper / use as starter stack)
- [Hello world web app with server and client in separate dirs / packages](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite-separate) (if you prefer that cleaner layout)
- [Hello world Web app with authentication](https://github.com/bogeeee/restfuncs/tree/main/examples/express-and-vite-with-authentication) (uses things from the Advanced chapter)


_They use vite, which is a very minimalistic/ (zero conf) web packer with full support for React/JSX, Typescript, hot module reloading. Hope you'll like this as a starter stack for your webapp._


# Advanced

### Html / images / binary as a result

To serve a non API result, the service method must explicitly **set the content type**. Return the result via `string`, `Buffer` or `Readable`. Example:
```typescript
    @safe() // Lessen restrictions and allow this method to be called by GET ...
    async getAvatarImage(name: string) {
        // ... therefore (SECURITY) code in @safe() methods must perform read operations only !
        this.res?.contentType("image/x-png")
        return fs.createReadStream("/someImage.png") // Returns a Readable which is streamed to client. You can also return Buffer, String, File(TODO)
    }
```

## REST interface

Like the name restfuncs suggests, there's also a REST interface for the case that you don't use the neat RPC client or you want to call these from other languages, etc.  
<br/>
Restfuncs follows a **zero conf / gracefully accepting** approach:  
The following example service method...
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
| GET | _/**getBook**?__&lt;custom implementation&gt;_ | | Override the `parseQuery` method in your Service subclass. See JSDoc.  [Here's a discussion about different url serializers](https://stackoverflow.com/questions/15872658/standardized-way-to-serialize-json-to-query-string) 
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
  _Note that it currently doesn't support nested properties like `myFunc(i: {someDate: Date})`. Set and Map are also not supported. Have a look at the source of `Service.autoConvertValueForParameter_fromJson` method to improve it._

_Restfuncs won't try to convert to ambiguous types like `string|bool` cause that would be too much magic and could cause unwanted behaviour flipping in your app (i.e., someone evil enters 'true' as username and this makes its way to a query param)._

_Note for the security cautious of you: After all this "wild" parameter collection and auto conversion, the actual call-ready parameters will be security-checked again in a [second stage](#runtime-arguments-typechecking-shielding-against-evil-input)._

### Receiving content (json-like result)
To specify what you want to **receive** in the response, Set the `Accept` header to
 - `application/json` _(**default**)_ - Mind that JSON lacks support for some Data types.
 - [`application/brillout-json`](https://www.npmjs.com/package/@brillout/json-serializer) - Better.

# Security

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
  - The Client calls the `getCorsReadToken()` service method to get a token string. Every service has that method inherited from the Service base class. This the *read-proof*.
  - Every http request now includes the fields `csrfProtectionMode=corsReadToken` and `corsReadToken=<the token>` in the headers, in the query (GET only) or in the body like [usual named parameters](#rest-interface). See the `devForceTokenCheck` option for development. A http response code `480` is sent when the token was missing/incorrect.

* `csrfToken`
  Strictly checks for a token that's been delivered in the start page (by your implementation). It's checked on every call / every session access _(enforced by client / enforced by server)_. The advantage is just that it relies less on in-depth defence / reflection of browser-behaviour and is commonly considered a simple-and-effective industry standard.
  - You deliver/embed the csrfToken, which you've got from `yourService.getCsrfToken(session: object)` or `app.getCsrfTokens(session: object)`, inside your *main / index.html* page. This is the tricky/inconvenient part, cause you usually use some web packer.
  - When using the restfuncs client, you pass it to the options via {csrfProtectionMode:"csrfToken", csrfToken: theToken}.
  - With plain fetch requests, you include the parameter: `csrfToken=<the token>` _in the header, in the query (GET only) or in the body like a [usual named parameter](#rest-interface)_. A http response code `403` is sent when the token was missing/incorrect.



Notes:
- [More on the security concept](server/Security%20concept.md#csrf-protection)
- For, when having multiple services: _Services share the same session, but still every service has its individual corsReadToken and csrfToken (cause allowedOrigins or other security settings may be individual). For csrfTokens, you can pass all tokens as one comma separated string, and the server will just try them all out._


### Simple requests and @safe()

On some requests, the browser will not make preflights for legacy reason. These are called [Simple requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS#simple_requests). **Restfuncs blocks them** accordingly (while showing hintfull error messages), but your service methods can, if needed for some situations, be **opted in** for such calls by decorating them with `@safe()` which indicates, that you are sure, they make **read operations only**. See the JDDoc of `import {@safe} from "restfuncs-server"`

## Hardening security for the paranoid
- Install the cookie handler with `cookie: {sameSite: true}`. TODO: Automatically do this if all services have default / same-site allowedOrigins
- Set `RestfuncsOptions.csrfProtectionMode` to `csrfToken` and implement the csrf token handover.
- TODO: List all sorts of disableXXX options to disable unneeded features

## Old: Security note**
- TODO: null req.session / add proxy with errormessage instead if this notice.
  Raw access to the session via `this.req.session` (or through plain express handlers or other middlewares) is not [shielded against csrf attacks](#csrf-protection). Use `this.session` from inside the service method instead, just like in the example above and you are fine.<br/><br/>




# Performance

### Writes to the session are slow...
... cause they trigger a http (non-websocket) request to update the session.

### Multi server environment
When using a load balancer in front of your servers, you have to configure it for [sticky sessions](https://socket.io/docs/v4/using-multiple-nodes/#enabling-sticky-session), because the underlying engine.io uses http long polling by default.  

# That's it !

### Comparison to other RPC frameworks
[Comparison table](https://github.com/bogeeee/RPCFrameworksComparison)

### _Contribution_

See [DEVELOPMENT.md](DEVELOPMENT.md)

Places where your help would be needed

- Client code generator for Java, C#, Python, Rust. Typesafe / with types. The idea is to integrate this as a download inside the (upcoming) API -/ docs browser. This would all be generated automatically at runtime. We already have typescript-rtti but there also needs to be some transformer that makes the jsdoc available.   
- Security review this and of typescript-rtti
- Enhance [testcases for typescript-rtti](runtime-typechecking.test.ts) to cover the complete typescript language spec / check for all kinds of escapes.
- Review or rewrite the busboy library. Currently, it is very "leet" code that's hard to inspect. What we need is at least some guarantee that it's side effect free.
- Write a 3rd party `Service` base class for authentication (session based, oauth, SSO).   