Example with authentication

### Run it
```bash
git clone https://github.com/bogeeee/restfuncs.git
cd restfuncs/examples/express-and-vite-with-authentication
npm install --ignore-scripts
npm run build
npm run start
```


### Development
Security is disabled.
```bash
npn run dev
```


Or `npn run dev:faster_no_typeInfo` which reloads faster and should still be good enough for your usual development needs.

_The starter script might look a bit strange but these routes work you through the CommonJS / ESM / typescript / transformer / with_proper_debugging  jungle. Hope, we will get a version for bun and be relieved one day ;)_