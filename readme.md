### - Warning: Not yet secure for production -
A Restfuncs dependency: typescript-rtti [still has some flaws and lacks regression tests](https://github.com/typescript-rtti/typescript-rtti/issues/112), and i can't give green light here. 
I'm keeping track of that and will also try to switch the validators to [TYPIA](https://typia.io/docs/) but this might not be before march 2024.

# Restfuncs 2.0 - HTTP API done proper

## Intro + features

With restfuncs, you write your http API endpoints just as **plain typescript func**tion**s**. Or better say: methods.  
Per-endpoint boilerplate is basically:
````typescript
@remote()
greet(name: string) {
    return  `Hello ${name}` 
}
````
See, it uses natural parameters and natual `return` and `throw` flow, instead of dealing with `req` and `res` and Restfuncs will take care about a lot more of your daily, low-level communication aspects.  
That is (features):
- 🔌 **Automatic [REST interface](#rest-interface)**, that comes without any `@Get`, `@Post`, `@route`, `@param`, ... decorations. Say goodbye to them.
- 🛡️ **Automatic arguments validation** from native typescript types: Like here, you said: name is a string. _More than that it can be declared any complex typescript type_. Restfuncs will validate that automatically at runtime.  _No need to repeat yourself in any inconvenient declaration language, no need to learn ZOD._ How does it work ? As we know, typescript usually erases all types at runtime. Therefore, Restfuncs needs a [tsc compiler plugin](https://www.npmjs.com/package/restfuncs-transformer), to add that type information. _It's currently just a wrapper for [typescript-rtti](https://typescript-rtti.org) and all the props go out to these guys ;)._ [See, how to set it up](#setting-up-the-build-the-annoying-stuff-).
- 🍾 **RPC client** (this is the best part 😄😄😄): Just call your remote methods from the client/browser as if they were lokal like `await myRemoteSession.greet("Axel")`, while enjoying full end2end type safety.
  - 🚀 Uses **engine.io (web-) sockets** (default, but can be switched to plain HTTP as well): The client automatically tries to upgrade to  (web-) sockets for faster round trips, better call batching, better general performance and push features. Restfuncs makes the behaviour interoperable with classic http: Changes to session fields (**the session cookie**) are automatically and securely **synchronized** to/from other classic http calls, non-restfuncs-clients and clients in other browser tabs.  
- **🔐 Security first approach**: All protection is in place by default. Exceptions, where you need to take action, are hinted explicitly in the docs, or by friendly error messages on unclear configuration. [Friendly hint here, for, when using client certificates or doing manual http fetches in the browser](#csrf-protection).  
  Restfuncs is designed to handle setups with different security settings per ServerSession class _while they (always) share one cookie-session_. I.e, think of serving a subset of your APIs (ServerSessions) to ALL origins for third party browser apps or for SSO. _[How it works internally](server/Security%20concept.md)_
  - 🛡️ **[CSRF protection](#csrf-protection) with zero-conf**: Especially no csrf tokens need to be passed by you.  _This is said so easy, but there's much effort and research behind the scenes for an in-depth protection of all possible http call situations and also to secure the socket connection._
  - **🔓CORS** of course also ;), _plays together with the above_. Just set the `ServerSessionOptions#allowedOrigins` and that's it.
- **Serve / stream resources**: You can also use your remote methods to [serve/stream resources like html pages / images / pdfs / ...](#html--images--binary-as-a-result) just by returning a `Readable`/`Buffer`/`string`
- COMING SOON: These coming-soon features are already concepted into the API and already appear in the docs. I'm trying my best, to keep new features non-breaking to make the current 2.x version stay the head.
- COMING SOON: **Callback functions** as usual parameters: Easy and great for reacting to events (subscriptions), progress bars, chat rooms, games, realtime data, ... _Those callbacks cause no polling and get **pushed** via the sockets of course._ There are options for skipping and rate limiting.
- COMING SOON: Simple **file uploads**: You can [use the Restfuncs client](#ltboilerplate-cheat-sheet---all-you-need-to-knowgt) or [multipart/mime forms (classic)](#rest-interface).
- COMING SOON: **Scalable to a multi node environment**. Uses stateless, encrypted tokens (JWT like) for cookie sessions with whitelist validation (be default, for keeping security and low memory footprint / best of both worlds). See `ServerOptions#secret` and `ServerOptions#sessionValidityTracking`
- COMING SOON: **Argments and result shaping**: Means just: Removing **extra** properties automatically whose would otherwise cause an invalid parameter / result. 
- COMING SOON: **Basic auth** handler. Http-session based auth is also covered by the [example](https://github.com/bogeeee/restfuncs/tree/2.x/examples/express-and-vite-with-authentication)
- FUTURE 2.x: **API browser** Zero conf and automatically hosted. Just give your partners an URL and they've got all the information and examples they need to call your methods from other programming languages...
  - FUTURE 2.x:  ... + can also download the **OpenAPI spec** from there.

Smaller features:
- **Result validation**: Also your returned values get validated (by default) to what's declared. Improves safety. COMING SOON: Support for shaping, so you can use some typescript tricks like `Pick` and `Omit` to shape your result into the desired form. 
- Proper **error handling** and logging.
- **Lazy cookies** throughout: The best session-cookie is one, that is never sent. That is only, if a field of your ServerSession is set to non-initial value, or if (in-depth) csrf protection ultimately requires it. Lessens parsing and validation costs i.e. for public users of your site that never log in. 
- **[A collection of example projects](#example-projects)**. Grab them, if you're looking for a quick starter for your single page application.
- **Enhancement friendly** library by exposing a clear OOP API. You are allowed and encouraged to subclass and override methods. Includes .ts source code, source maps and declaration maps in the published NPM package, so you can ctrl+click or debug-step yourself right into the source code and have some fun with it - i hope this inspires other lib authors ;). TODO: Document basic-call-structure.md  
- **Very compact** conceptual **documentation**. "All you need to know" fits on 2.5 screen pages. Further is shown by your IDE's intellisense + friendly error messages give you advice. So let's not waste words and [get right into it](#ltboilerplate-cheat-sheet---all-you-need-to-knowgt):

# &lt;Boilerplate cheat sheet - all you need to know&gt;

**Security note:** When using client certificates, you must also read the [CSRF protection chapter](#csrf-protection).

**MyServerSession.ts**

````typescript
import {ServerSession, ServerSessionOptions, UploadFile, remote, ClientCallback} from "restfuncs-server";

export class MyServerSession extends ServerSession {

  static options: ServerSessionOptions = {/* ... */}

  myLogonUserId?: string // This value gets stored in the session-cookie under the key "myLogonUserId".

  /**
   * This JSDoc also gets outputted in the public API browser and OpenAPI spec. Write only nice things here ;)
   * @param myComplexParam Your parameters can be of any typescript type. They are automatically validated at runtime.
   * @param myCallback   You can pass server->client callback functions anywhere/deeply                          . Here we send the progress of the file upload.
   * @param myUploadFile You can pass UploadFile objects                anywhere/deeply/also as ...rest arguments. As soon as you read from the the stream, the restfuncs client will send that file in an extra http request in the background/automatically.
   */
  @remote({/* RemoteMethodOptions */})
  myRemoteMethod(myComplexParam: { id?: number, name: string }, myCallback?: (percentDone: number) => void, myUploadFile?: UploadFile) {
    // ADVANCED:
    // this.call.... // Access or modify the current call's context specific properties. I.e. this.call.res!.header("myHeader","...")
    // (myCallback as ClientCallback).... // Access some options under the hood

    return `Hello ${myComplexParam.name}, your userId is ${this.myLogonUserId}` // The output automatically gets validated and shaped into the declared or implicit return type of `myRemoteMethod`. Extra properties get removed. TODO: See Typescript tips an tricks on how to shape the result
  }

  // ... <-- More @remote methods  
  // ... <-- @remote methods that serve html / images / binary. See TODO:baseurl/#html--images--binary-as-a-result    
  // ... <-- Override the `doCall` method to intercept each call (i.e. check for auth (see example project), handle errors, filter args, filter result).
  // ... <-- Override other methods from the ServerSession base class for advanced tweaking (use intellisense and read the method description). Also see the static methods.
}
````
**server.ts**
````typescript
import {restfuncsExpress} from "restfuncs-server";
import {MyServerSession} from "./MyServerSession.js";

const app = restfuncsExpress({/* ServerOptions */}) // Drop in replacement for express. Installs a jwt session cookie middleware and the websockets listener. Recommended.

app.use("/myAPI", MyServerSession.createExpressHandler())
// ... app.use(helmet(), express.static('dist/web')) // Serve pre-built web pages / i.e. by a bundler like vite, parcel or turbopack. See examples. It's recommended to use the helmet() middleware for additional protection.
// ... app.use(...) <-- Serve *other / 3rd party* express routes here. SECURITY: These are not covered by restfuncs CSRF protection. Don't do write/state-changing operations in here ! Instead do them by MyServerSession.

app.listen(3000); // Listen on Port 3000
````
**client.ts**
````typescript
// Use a bundler like vite, parcel or turbopack to deliver these modules to the browser (as usual, also see the example projects): 
import {UploadFile} from "restfuncs-common";
import {RestfuncsClient} from "restfuncs-client";
import {MyServerSession} from "../path/to/server/code/or/its/packagename/MyServerSession.js" // Gives us the full end2end type support

const myRemoteSession = new RestfuncsClient<MyServerSession>("/myAPI", {/* options */}).proxy; // Tip: For intercepting calls (+ more tweaks), sublcass it and override `doCall`. See the auth example.  

console.log( await myRemoteSession.myRemoteMethod({name: "Hans"}) ); // finally, call your remote method over the wire :)

// And an example call with a callback + a file upload:
const myDomFile = document.querySelector("#myFileInput").files[0]; // Retrieve your File object(s) from an <input type="file" /> (here), or from a DragEvent.dataTransfer.files
await myRemoteSession.myRemoteMethod(...,  (progress) => console.log(`myCallback says: ${progress}% uploaded`), myDomFile as UploadFile /* The trick is, to just cast it. */)
````

### Setting up the build (the annoying stuff 😈)

**tsconfig.json**
````json
"compilerOptions": {
    "moduleResolution": "node",
    "experimentalDecorators": true,
    "strictNullChecks": true,
    "sourceMap": true, //optional, recommended
    "plugins": [
        { "transform": "restfuncs-transformer",  "transformProgram": true},
        { "transform": "typia/lib/transform" },
        { "transform": "typescript-rtti/dist/transformer" } ],
},
"exclude": ["dist", "client", "web"], // Make sure, to not accidentially transform your client files.
````
**package.json**
````json
"scripts": {
    "dev": "...use your beloved and fast tsx/bun/jest/vitest/... runners and just disable all validation via the ServerSessionOptions#devDisableSecurity flag"
    "clean": "tspc --build --clean",
    "build": "tspc --build --force",
    "start": "node --enable-source-maps server.js"
},
"dependencies": {
  "restfuncs-server": "^3.0.0",
  "restfuncs-client": "^2.0.0"
},
"devDependencies": {
  "ts-patch": "^3.0.2",
  "restfuncs-transformer": "^1.0.0"
},
````
_Here we compile with `tspc` (instead of `tsc`) from the [ts-patch](https://www.npmjs.com/package/ts-patch) package (in live mode, nothing will be patched here), which allows for our `restfuncs-transformer` plugin in tsconfig.json._


## &lt;/Boilerplate cheat sheet&gt;

_Congrats, you've got the concept!  
Now use your IDE's intellisense and have a quick browse through the `/* XxxOptions */` and also the `Callback` and `UploadFile` description/members. That JSDoc is considered the official documentation and it won't be repeated here.
In some cases where more configuration needs to be decided for, contextual error messages will guide you. So don't be scared of them and read them and see them as part of the concept._

<br/><br/><br/><br/><br/><br/>

# Example projects

- [Hello world web app](https://github.com/bogeeee/restfuncs/tree/2.x/examples/express-and-vite) (use as starter stack)
- [Hello world web app with server and client in separate dirs / packages](https://github.com/bogeeee/restfuncs/tree/2.x/examples/express-and-vite-separate) (if you prefer that cleaner layout)
- [Hello world Web app with authentication](https://github.com/bogeeee/restfuncs/tree/2.x/examples/express-and-vite-with-authentication) (uses things from the Advanced chapter)


_They use vite, which is a very minimalistic/ (zero conf) web packer with full support for React/JSX, Typescript, hot module reloading. Hope you'll like this as a starter stack for your webapp._


# Advanced

### Html / images / binary as a result

To serve a non API result, the remote method must explicitly **set the content type**. Return the result via `string`, `Buffer` or `Readable`. Example:
```typescript
    @remote({isSafe: true /* Lessen restrictions and allow this method to be called by GET ... */}) 
    getAvatarImage(name: string) {
        // ... therefore (SECURITY) code in `isSafe` methods must perform read operations only !
        this.call.res!.contentType("image/x-png")
        return fs.createReadStream("/someImage.png") // Returns a Readable which is streamed to client. You can also return Buffer, String, File(TODO)
    }
```

**Security note:** When serving html with rich content or with scripts, you might want to add the [helmet](https://www.npmjs.com/package/helmet) middleware in front of your ServerSession for additional protection via `app.use("/myAPI", helmet(), MyServerSession.createExpressHandler())`

## REST interface

**Security note:** For handcrafted calls from inside a **browser**, you (the clients) need to care about [protecting your session from CSRF](#csrf-protection).

**Tl;dr:** Just form the http call from your imagination, and its likely a way that works, or Restfuncs will tell you exactly, what's wrong with the params.

Now to the content:  
Like the name Restfuncs suggests, there's also a REST/http interface for the case that you don't use the neat RestfuncsClient, or you want to call these from non-js languages, etc.  
Restfuncs follows a **zero conf / gracefully accepting / non-strict** approach (a client is still free to implement strictness to the REST paradigm):  
The following example remote method...
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
| GET | _/**getBook**?__&lt;custom implementation&gt;_ | | Override the `parseQuery` method in your ServerSession subclass. See JSDoc.  [Here's a discussion about different url serializers](https://stackoverflow.com/questions/15872658/standardized-way-to-serialize-json-to-query-string) 
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
  _Note that it currently doesn't support nested properties like `myFunc(i: {someDate: Date})`. Set and Map are also not supported. Have a look at the source of `ServerSession.autoConvertValueForParameter_fromJson` method to improve it._

_Restfuncs won't try to convert to ambiguous types like `string|bool` cause that would be too much magic and could cause unwanted behaviour flipping in your app (i.e., someone evil enters 'true' as username and this makes its way to a query param)._

_Note for the security cautious of you: After all this "wild" parameter collection and auto conversion, the actual call-ready parameters will be security-checked again in a [second stage](#runtime-arguments-typechecking-shielding-against-evil-input)._

### Receiving content (json-like result)
To specify what you want to **receive** in the response, Set the `Accept` header to
 - `application/json` _(**default**)_ - Mind that JSON lacks support for some Data types.
 - [`application/brillout-json`](https://www.npmjs.com/package/@brillout/json-serializer) - Better.

# Security

## CSRF protection

**Tl;dr:** **In a normal situation** (= no basic auth, no client-certs and using the RestfuncsClient), **Restfuncs already has a strong CSRF protection by default** (`corsReadToken`, enforced by the RestfuncsClient). For other situations, read the following:

Restfuncs has the following 3 protection levels (weakest to hardest) to protect against CSRF attacks. See list below.
You can enforce it by the `ServerSessionOptions#csrfProtectionMode` setting.  
**By default/ undefined, the client can decide the protection mode**. _"wait a minute, how can this be secure ?" See explanation_. This way, all sorts of clients can be served. Think of non-browser clients where CSRF does not have relevance, so their devs are not bugged with implementing token fetches.  
_Explanation: The clients indicate, which csrfProtection mode they want to "play" in a header proactively on every request. Restfuncs will raise an error, if another browser client (or i.e an attacker from another browser tab) wants to play a different mode, at the moment it tries to access the (same) session. Meaning, once the (cookie-) session is created,  the protection mode is stored in there. Note: "proactively" means: no header = defaulting to `preflight` is still allowed, as long as it's consistent._

The above policy (let the clients decide) only covers sessions. So <strong>when using client-certificates or basic auth, you must explicitly decide for a setting</strong>, and you should use at least set it to `corsReadToken` when dealing with browser clients.

Here are the modes. `ServerSessionOptions#csrfProtectionMode` / `RestfuncsClient#csrfProtectionMode` can be set to:

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
  - The Client calls the `getCorsReadToken()` ServerSession method to get a token string. This the *read-proof*.
  - Every further http request now includes the fields `csrfProtectionMode=corsReadToken` and `corsReadToken=<the token>` in the headers, in the query (GET only) or in the body like [usual named parameters](#rest-interface). See the `devForceTokenCheck` option for development. A http response code `480` is sent when the token was missing/incorrect.

* `csrfToken`
  Strictly checks for a token that's been delivered in the start page (by your implementation). It's checked on every call / every session access _(enforced by client / enforced by server)_. The advantage is just that it relies less on in-depth defence / reflection of browser-behaviour and is commonly considered a simple-and-effective industry standard.
  - You deliver/embed the csrfToken, which you've got from `yourServerSessionClass.getCsrfToken(session: object)` or `app.getCsrfTokens(session: object)`, inside your *main / index.html* page. This is the tricky/inconvenient part, cause you usually use some web packer.
  - When using the restfuncs client, you pass it to the options via {csrfProtectionMode:"csrfToken", csrfToken: theToken}.
  - With plain fetch requests, you include the parameter: `csrfToken=<the token>` _in the header, in the query (GET only) or in the body like a [usual named parameter](#rest-interface)_. A http response code `403` is sent when the token was missing/incorrect.



Notes:
- [More on the security concept](server/Security%20concept.md#csrf-protection)
- For, when having multiple ServerSession classes: _They share the same cookieSession, but still every ServerSession class (or security group) has its individual corsReadToken and csrfToken there (cause allowedOrigins or other security settings may be individual). For csrfTokens, you can pass all tokens as one comma separated string, and the server will just try them all out._

## Hardening security for the paranoid
- Install the cookie handler with `cookie: {sameSite: true}`. TODO: Automatically do this if all services have default / same-site allowedOrigins
- Set `ServerSessionOptions#csrfProtectionMode` to `csrfToken` and implement the csrf token handover.


# Performance

To be honest here, this current Restfuncs release's first goal is to be stable and secure. Surely, it  will compete with a traditional express handcrafted handlers or usual frameworks, 
Plus it also has the (web) socket server and there are architectural considerations to avoid round trips and lookups. But real profiling and in-detail optimizations have to be made, to make it competitive to bun, µWebsockets and other high-throughput libraries.
Feel free,to benchmark it and contribute to optimizations.

Also in general: You should never talk about performance in theory without having actually profiled your application. I.e. one single simple sql call to a database server (in dimensions of around 100µs on an average cpu) will probably overshadow all the call time of all your communication library.
But it's no excuse to not take it sportive ;)... i will focus on this topic later.

### Skip shaping and validation passes
For a performance-critical method, or for all methods (via `static defaultRemoteMethodOptions: RemoteMethodOptions = {...}` in your ServerSession class), do the following:
 - Disable `shapeArguments`, `shapeResult` and `validateResult` (but mind security here).
 - _If the server is trusted and authenticated (server 2 server), you would even disable `validateInput`._ 

### Further performance options
- Read JSDoc and disable `ServerOptions#socket_requireAccessProofForIndividualServerSession`

### Writes to the session fields have some overhead
It costs an additional http roundtrip + 1 websocket roundtrip + (auto.) resend of unprocessed websocket calls. This is to ensure fail-safe commits to the http cookie and to ensure security. So keep that in mind.

### Multi server environment
When using a load balancer in front of your servers, you have to configure it for [sticky sessions](https://socket.io/docs/v4/using-multiple-nodes/#enabling-sticky-session), because the underlying engine.io uses http long polling as a first, failsafe approach. You might try to also change that.  

# That's it !

### Comparison to other RPC libraries
[Comparison table](https://github.com/bogeeee/RPCFrameworksComparison)

### _Contribution_

See [DEVELOPMENT.md](DEVELOPMENT.md)

Places where your help would be needed

- Client code generator for Java, C#, Python, Rust. Typesafe / with types. The idea is to integrate this as a download inside the (upcoming) API -/ docs browser. This would all be generated automatically at runtime. We already have typescript-rtti but there also needs to be some transformer that makes the jsdoc available.   
- Review or rewrite the busboy library. Currently, it is very "leet" code that's hard to inspect. What we need is at least some guarantee that it's side effect free.
- Write a 3rd party `ServerSession` base class for authentication (session based, oauth, SSO).   