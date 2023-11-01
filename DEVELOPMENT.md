### Prepare

```bash
git clone https://github.com/bogeeee/restfuncs.git
npm install
```
_This autoinstalls dependencies for every sub-package / workspace ;)_


### Code

During coding, you would normally:
```bash
npm run dev:watch-and-run-tests
```

When you want to test your code changes with the examples, then:
```bash
npm run build
```
This compiles the /**/dist/mjs which are what's used from the browser/vite packager. Then cd into the examples and `npm run dev` them.    
_eventually remove the /package-lock.json if examples still stick to old packages_

### Terminology
- `cookieSession` means the raw session from the cookie. While `ServerSession` instance may have the same values, as these are copied/mapped, but different lifecycle: it can exist, even if the cookieSession is not yet initialized (there was no cookie sent)
- `Service` is often used as a synonym for `ServerSession- **class**. Often used, when referred in the static context / the static fields of that class, i.e. the `options`.
- `socket` vs. `http side`: Refers to, that the communication goes either through an engine.io socket (websocket or similar) vs. through classic http requests.
_The classic http client-server communication was implemented first and is considered the always available and the source of truth when it comes to holding the cookie session or deciding whether requests are allowed._ 