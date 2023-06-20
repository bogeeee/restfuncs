# Input parsing
- Restfuncs has 2 stages:
  1. First, the parameters will be collected and auto converted via `collectParamsFromRequest`. This can be very wild. It's only important that this code is side effect free. 
     The busboy (multipart parsing) parsing will only happen if really needed, so if that method has `readable` or `UploadFile` parameters. Cause the busboy code looks very "leet" and i find it hard to inspect it for side effects. 
  2. We assume that stage 1 was evil and any evil parameters can make it to here. So the call-ready parameters will be security-checked again by RestService.validateAndDoCall()

# Validation via typescript-rtti
- The typescript-rtti library needs more reviewing.
   - More testcases should be added there.
-  [Extra properties validation](https://github.com/typescript-rtti/typescript-rtti/issues/92) is rather new and still flagged as open.

#CSRF protection
 
- [Here](https://stackoverflow.com/questions/24680302/csrf-protection-with-cors-origin-header-vs-csrf-token?noredirect=1&lq=1) is a discussion of adpapting in-depth to browser behaviour vs csrf tokens. There's no point whether this could be unsafe for restfuncs' logik. 
- As mentioned in [readme.md](../readme.md#csrf-protection). There's this unclear in-spec/in-practice situation with `preflight`. That's why `corsReadToken` mode was introduced and the restfuncs-client implements this by default. So the user is a bit safer by default ;)
- Tokens that get send to the client are shielded against the BREACH attack (xor'ed with a random nonce).
- TODO: check for [sendBeacon](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon)
- TODO: Show the shortened code of requestIsAllowedToRunCredentialed here
- See the [CrossSiteSecurity testcases application](../tests/crossSiteSecurity) which tests if this logic is working.