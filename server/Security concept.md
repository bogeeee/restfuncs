# Input parsing
- Restfuncs has 2 stages:
  1. First, the parameters will be collected and auto converted via `collectParamsFromRequest`. This can be very wild. It's only important that this code is side effect free. 
     The busboy (multipart parsing) parsing will only happen if really needed, so if that method has `readable` or `UploadFile` parameters. Cause the busboy code looks very "leet" and i find it hard to inspect it for side effects. 
  2. We assume that stage 1 was evil and any evil parameters can make it to here. So the call-ready parameters will be security-checked again by ServerSession.validateCall()

# Validation via typescript-rtti
- The typescript-rtti library needs more reviewing.
   - More testcases should be added there.
-  [Extra properties validation](https://github.com/typescript-rtti/typescript-rtti/issues/92) is rather new and still flagged as open.

#CSRF protection
 
- [Here](https://stackoverflow.com/questions/24680302/csrf-protection-with-cors-origin-header-vs-csrf-token?noredirect=1&lq=1) is a discussion of adpapting in-depth to browser behaviour vs csrf tokens. There's no point whether this could be unsafe for restfuncs' logik. 
- As mentioned in [readme.md](../readme.md#csrf-protection). There's this unclear in-spec/in-practice situation with `preflight`. That's why `corsReadToken` mode was introduced and the restfuncs-client implements this by default. So the user is a bit safer by default ;)
- Tokens that get send to the client are shielded against the BREACH attack (xor'ed with a random nonce).
- TODO: Show the shortened code of requestIsAllowedToRunCredentialed here
- See the [CrossSiteSecurity testcases application](../tests/crossSiteSecurity) which tests if this logic is working.


# Websockets
_"http" referes to traditional non-websocket http here_
_"encrypted" means: Symmetrical encrypted by the server + MAC'ed. (MAC'ed only would even mostly be fine but for simplicity, we always encrypt)

All the above applies to traditional http and all this seems fine but now come Websockets and new problems arise:
- Do calls to Websockets regard CORS and the same security restrictions normal http calls ?
- Do all browsers properly implement this ?
- Can we keep track of the session content in websocket connections ? The session cookie might only be sent during connection establishment and from there on have a stale value
- There's even no proper API in engine.io for checking all the http state and cookies

The answer to all this is: We don't secure websocket connections themselves (+they're CORS allowed to all origins)
Instead, the client pulls the context in which it operates from the main trusted http service to the websocket connection via encrypted tokens.
Context means: "Can the client make requests to the service ?" + the full content of the session + the req (http request) object, which may contain the basicAuth user + clientcert info + other identifying stuff.

See the types: AreCallsAllowedQuestion, AreCallsAllowedAnswer and corresponding methods in the ServerSession
For session transfer, see: SessionTransferRequest, SessionTransferToken, UpdateSessionToken. and corresponding methods in the ServerSession

Tokens always contain an unguessable id from inside the websocket handler's situation, so they can't be replaced with tokens which an attacker has in stock (previously validly obtained by his own connection) and also can't be replayed.

The main source of truth for the session is the http cookie. The websocket connection is only a downstream subscriber and also can push updates there (see the above tokens). A unique session key + a version number makes sure that it can't be updated to an old value.
