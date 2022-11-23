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