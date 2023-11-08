### Prepare

```bash
git clone https://github.com/bogeeee/restfuncs.git
npm install
```
_This autoinstalls dependencies for every sub-package / workspace ;)_


### Running tests

During coding, you would normally run `test:watch-and-run-tests`,
or, because the filewatcher loves to crash often, start them manually with `test:compile_and_run_tests`  

Fore these to run, you must first run: `dev:mustBuildTheTransformerFirst` (also after a `clean`)


### Test (with) examples
You would want to test your code changes with the examples, or use them as a playground, then (from the root):
```bash
npm run build
```
This compiles the /**/dist/mjs which are what's used from the browser/vite packager. Then cd into the examples and `npm run dev` then.    
_eventually remove the /package-lock.json if examples still stick to old packages_

Instead of the super slow `npm run build` from the root package, you could try *dev:fastbuild* (but does not rebuild the client for the browser) or look at `dev:playground`. Just try what works best.

### Terminology
- `cookieSession` means the raw session from the cookie. While `ServerSession` instance may have the same values, as these are copied/mapped, but different lifecycle: it can exist, even if the cookieSession is not yet initialized (there was no cookie sent)
- `Service` is often used as a synonym for `ServerSession- **class**. Often used, when referred in the static context / the static fields of that class, i.e. the `options`.
- `socket` vs. `http side`: Refers to, that the communication goes either through an engine.io socket (websocket or similar) vs. through classic http requests.
_The classic http client-server communication was implemented first and is considered the always available and the source of truth when it comes to holding the cookie session or deciding whether requests are allowed._ 