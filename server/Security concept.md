# Input parsing
- Restfuncs has 2 stages:
  1. First, the parameters will be collected and auto converted via `collectParamsFromRequest`. This can be very wild. It's only important that this code is side effect free. 
     The busboy (multipart parsing) parsing will only happen if really needed, so if that method has `readable` or `UploadFile` parameters. Cause the busboy code looks very "leet" and i find it hard to inspect it for side effects. 
  2. We assume that stage 1 was evil and any evil parameters can make it to here. So the call-ready parameters will be security-checked again by ServerSession.validateCall()

# Validation library
This is a very sensitive part, as it should detect every possible type violation of an attacker's input.
You might have seen the big security warning i've made in the 2.x release's readme because the typescript-rtti library [lacks of validation test cases](https://github.com/typescript-rtti/typescript-rtti/issues/112).  
Good news: Since 3.x, i've switched over to Typia which is heavily covered by such security tests: It tests an impressive amount of currently [167 different Typescript structures](https://github.com/samchon/typia/tree/master/test/src/structures) with **975 spoiler tests** in total.
_Still typescript-rtti is very useful for other tasks that are not in the security critical path._
    
# CSRF protection
Make sure you've read the [CSRF protection topic in the documentation](../readme.md#csrf-protection) first.
- [Here](https://stackoverflow.com/questions/24680302/csrf-protection-with-cors-origin-header-vs-csrf-token?noredirect=1&lq=1) is a discussion of adpapting in-depth to browser behaviour vs csrf tokens. There's no point whether this could be unsafe for restfuncs' logik. 
- As mentioned in [readme.md](../readme.md#csrf-protection). There's this unclear in-spec/in-practice situation with `preflight`. That's why `corsReadToken` mode was introduced and the restfuncs-client implements this by default. So the user is a bit safer by default ;)
- Tokens that get send to the client are shielded against the BREACH attack (xor'ed with a random nonce).
- The core CSRF checking method is: ServerSession#checkIfRequestIsAllowedCrossSite
- See the [CrossSiteSecurity testcases application](../tests/crossSiteSecurity) which tests if this logic is working.

Here's a the core CSRF checking method. Diagnosis and some other stuff was removed. It's called from 2 places. Before each call, and lazily on session field access (this is a "credential" to protect),
with enforcedCsrfProtectionMode set to, what's currently stored in the cookie session.
````typescript
    const isAllowedInner = () => {
        if (this.isSecurityDisabled) {
            return true;
        }

        // Fix / default some reqSecurityProps for convenience:
        // ...

        // Check protection mode compatibility:
        if (enforcedCsrfProtectionMode !== undefined) {
            if ((reqSecurityProps.csrfProtectionMode || "preflight") !== enforcedCsrfProtectionMode) { // Client and server(/cookieSession) want different protection modes  ?
                return false;
            }
        }

        if (enforcedCsrfProtectionMode === "csrfToken") {
            if (reqSecurityProps.browserMightHaveSecurityIssuseWithCrossOriginRequests) {                
                return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
            }
            return tokenValid("csrfToken"); // Strict check already here.
        }

        if (originIsAllowed({...reqSecurityProps, allowedOrigins})) { // Check, if origin is allowed, by looking at the host, origin and referer fields.
            return true
        }

        // The server side origin check failed but the request could still be legal:
        // In case of same-origin requests: Maybe our originAllowed assumption was false negative (because behind a reverse proxy) and the browser knows better.
        // Or maybe the browser allows non-credentialed requests to go through (which can't do any security harm)
        // Or maybe some browsers don't send an origin header (i.e. to protect privacy)

        if (reqSecurityProps.browserMightHaveSecurityIssuseWithCrossOriginRequests) {
            return false; // Note: Not even for simple requests. A non-cors browser probably also does not block reads from them
        }

        if (enforcedCsrfProtectionMode === "corsReadToken") {
            if (reqSecurityProps.readWasProven || tokenValid("corsReadToken")) {  // Read was proven ?
                return true;
            }
        } 

        if (reqSecurityProps.couldBeSimpleRequest) { // Simple request (or a false positive non-simple request)
            // Simple requests have not been preflighted by the browser and could be cross-site with credentials (even ignoring same-site cookie)
            if (reqSecurityProps.httpMethod === "GET" && this.getRemoteMethodOptions(remoteMethodName).isSafe) {
                return true // Exception is made for GET to a safe method. These don't write and the results can't be read (and for the false positives: if the browser thinks that it is not-simple, it will regard the CORS header and prevent reading)
            } else {
                return false; // Deny
            }
        } else { // Surely a non-simple request ?
            // *** here we are only secured by the browser's preflight ! ***
            
            if (remoteMethodName === "getCorsReadToken") {
                return true;
            }
            
            if (enforcedCsrfProtectionMode === undefined || enforcedCsrfProtectionMode === "preflight") {
                return true; // Trust the browser that it would bail after a negative preflight
            }
        }

        return false;
    }
````


# Websockets (engine.io sockets)
_"http site" referes to traditional non-websocket http here_

All the above applies to traditional http and all this seems fine but now come Websockets and new problems arise:
- Do calls to Websockets regard CORS and the same security restrictions normal http calls ?
- Do all browsers properly implement this ?
- Can we keep track of the session content in websocket connections ? The session cookie might only be sent during connection establishment and from there on have a stale value
- There's even no proper API in engine.io for checking all the http state and cookies

The answer to all this is: We don't secure websocket connections themselves.
Instead, the client pulls the context in which it operates from the http site to the websocket connection via encrypted and signed tokens. (Method `Server#server2serverEncryptToken` is used)
Context means: 
 - The full content of the cookieSession.
 - The `SecurityPropertiesOfHttpRequest`, which includes all security relavant stuff and also the csrfToken/corsReadToken/csrfProtectionmode. [See type](../common/index.ts)  
When pulling these 2 objects, the id of the ServerSocketConnection is included in the request (question), and checked, when returned, so an attacker can't install foreign tokens.
   
The main source of truth of the cookieSession is always the http side. After a write, the cookieSession must be committed there, and then re-fetched to the ServerSocketConnection (like above, again with the id in the question). On each side, there are checks, that the session can only be updated *incrementally*, by checking the version and additionally a branch-protection-salt. ~~This is to prevent replay attacks. So your (new) calls can at maximum be only one version off, just like in a normal http setup~~ it will only mitigate replay attacks and at least prevent an attacker from installing that cookieSession version inside the victims browser tab. Real guarding must / will be done by the validator before every request (TODO).

Another advantage of this approach is, that all RestunfsClients can just share one connection, so they don't exhaust connections. The pulled `SecurityPropertiesOfHttpRequest` is simply associated to the ServerSession class id (or group of such with same security settings = `SecurityGroup`).

# Dependencies
- `not-so-weak@2.0.0` Had a quick review -> looks good. Therefore fixed to that version. 