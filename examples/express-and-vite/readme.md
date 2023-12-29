Simple hello world example with express server and vite as packager.  
The client web does not have its own package.json for simplicity.


### Run it
```bash
git clone https://github.com/bogeeee/restfuncs.git
cd restfuncs/examples/express-and-vite
npm install
npm run build
npm run start
```

### Development
Security is disabled.
```bash
npn run dev
```

_The starter script might look a bit strange but these routes work you through the CommonJS / ESM / typescript / transformer / with_proper_debugging  jungle. Hope, we will get a version for bun and be relieved one day ;)_