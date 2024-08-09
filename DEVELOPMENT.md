### Prepare

```bash
git clone https://github.com/bogeeee/restfuncs.git
cd restfuncs
npm install --ignore-scripts
```
_This autoinstalls dependencies for every sub-package / workspace ;)_


### Run the tests

`npm run tests`

### Test (with) examples
You would want to test your code changes with the examples, or use them as a playground, then (from the root):
```bash
npm run build
```
This compiles the transformer and the /**/dist/mjs which are what's used from the browser/vite bundler. Then cd into the examples and `npm run dev` then.    
_eventually remove the /package-lock.json if examples still stick to old packages_

Instead of the super slow `npm run build` from the root package, you could try *dev:fastbuild* (but does not rebuild the client for the browser) or look at `dev:playground`. Just try what works best.

### Terminology
- `cookieSession` means the raw session from the cookie. Contrary `ServerSession` instances may have the same fields, as these are copied/mapped, but a different lifecycle: it can exist, even if the cookieSession is not yet initialized (there was no cookie sent)
- `Service` is often used as a synonym for `ServerSession- **class**. Often used, when referred in the static context / the static fields of that class, i.e. the `options`.
- `socket` vs. `http side`: Refers to, that the communication goes either through an engine.io socket (websocket or similar) vs. through classic http requests.
_The classic http client-server communication was implemented first and is considered the always available and the source of truth when it comes to holding the cookie session or deciding whether requests are allowed._
- `Meta`: Information, about a remote method which is [added at compile time](transformer/readme.md#how-the-transformer-chain-works). 
  
- `Callback`, or `ClientCallback`: A function that is sent from the client to the server as an event-callback (see the event-callback feature in readme.md)
  - `Downcall`: When the server calls such a callback function (a call from the server to client). 
- `ChannelItem`: A ClientCallback, UploadFile or a Stream.  
- `DTO` / `ChannelItemDTO`: As the above can't be serialized directly, a handle to these is sent to the server. 
### Understanding the structure
- Read [ServerSession breakdown](server/ServerSession%20breakdown.md).
- Read [ServerSocketConnection breakdown](server/ServerSocketConnection%20breakdown.md)