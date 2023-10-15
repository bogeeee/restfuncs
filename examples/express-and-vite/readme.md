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
```bash
npn run dev
```

Or `npn run dev:faster_but_without_rtti` which reloads faster and should still be good enough for your usual development needs.  

_The dev script might look a bit strange but these routes work you through the CommonJS / ESM / typescript / transformer / with_proper_debugging  jungle ;)_